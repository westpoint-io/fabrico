import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalogEntry, encodeGridCommand } from '../protocol/decode.ts';
import type { BeltEnd, BeltView, NodeView } from '../protocol/decode.ts';
import {
  BELT_PORT_HEAD,
  beltHandlePoints,
  FAULT_PORT,
  nubAnchor,
  nubHitRadiusWorld,
  wireNubHitRadiusWorld,
  MEDIUM_ELECTRICAL,
  MEDIUM_MECHANICAL,
} from '../protocol/ports.ts';
import { CELL } from '../../shared/geometry.ts';
import { route } from '../protocol/route.ts';
import { createSceneState, type SceneState } from '../render/sceneState.ts';
import { pendingSeamTiles, pendingSeamsRecord, pendingSeamsRecords } from '../render/pendingSeams.ts';
import { machine_kind } from '../protocol/kinds.ts';
import {
  BELT_WALK_MAX_CELLS,
  BELT_WALK_MIN_ZOOM_MIRROR,
  createGestureController,
  routerPresetSeedCommands,
  type GestureController,
  type StrandedRing,
} from './gestures.ts';
import { MIN_ZOOM } from '../render/camera.ts';
import { cableLane } from '../render/cableLane.ts';
import { bodyOfNode, isWireObstacle, wireRouteAvoiding } from '../protocol/wireRoute.ts';
import { REFUSAL_COPY, type ClientRefusalTag } from '../chrome/RefusalMessage.tsx';
import type { OverlayAffordances } from './ghost.ts';
import {
  createQueuedClaims,
  deleteClaim,
  placeClaim,
  resizeClaim,
  type QueuedClaim,
  type QueuedClaims,
} from './queuedClaims.ts';
import { footprintFits } from './ghost.ts';
import type { GestureVerdict } from '../transport/transport.ts';
import type { CableNubs, NubEnd } from '../render/cableGeometry.ts';
import type { TileView } from '../protocol/decode.ts';
import { SHORTCUT_LIST, matchesShortcut, type Shortcut, type ShortcutId } from './shortcuts.ts';

/** World/screen point (identity cam shim → screen px == world px). */
/**
 * One recorded cable end: a plain copy of the nub the gesture handed `showRoute`, or null
 * for `NO_NUB`. Copied so a later repaint cannot rewrite an earlier reading.
 */
type RecordedNub = { x: number; y: number; nx: number; ny: number; cellX: number; cellY: number } | null;
interface RecordedNubs {
  from: RecordedNub;
  to: RecordedNub;
}
function copyNub(n: NubEnd): RecordedNub {
  return n === null ? null : { x: n.x, y: n.y, nx: n.nx, ny: n.ny, cellX: n.cellX, cellY: n.cellY };
}
function copyNubs(n: CableNubs): RecordedNubs {
  return { from: copyNub(n.from), to: copyNub(n.to) };
}

interface Pt {
  x: number;
  y: number;
}

// gestures.ts is the authoritative gesture controller: every gesture emits EXACTLY
// ONE logged GridCommand and the canvas reflects only the host echo (SC5). These
// units pin the two REND-04 gestures this plan adds — keyboard Rotate (R/Shift+R)
// and (in the draw-belt block below) the palette-armed manual belt draw.
//
// The vitest env is `node` (no DOM); we drive the controller through a tiny
// event-bus shim (window + canvas) so no browser/jsdom dependency is added — the
// phase's "zero new packages" discipline holds. The bus calls the registered
// handlers directly with plain synthetic events, which is deterministic and
// avoids Node Event/target quirks.

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

/** A rotated catalog port spec as passed to showGhost (plan 21-07). */
interface GhostPortSpec {
  lx: number;
  ly: number;
  side: number;
  role: number;
}

/** A recording overlay satisfying the structural OverlayAffordances handle. */
function makeOverlay(): OverlayAffordances & {
  ghostCalls: Array<{
    valid: boolean;
    dims?: { w: number; h: number; rot: number };
    ports?: GhostPortSpec[];
  }>;
  ghostCleared: { count: number };
  selections: number[];
  beltCalls: Array<{ tiles: TileView[]; valid: boolean }>;
  /**
   * Whether the draw-belt preview is ON SCREEN after the last show/clear, and how many
   * times it was cleared (plan 74.1-26, S1R). `clearBeltPreview` was a no-op here, so no
   * case could say whether the preview survived a release; the HELD PREVIEW cases read
   * this. A show with tiles, or a red show (the retained shape repainted in fault),
   * turns it on; a clear or an empty valid show turns it off, as the real overlay does.
   * `tiles` is the list the real overlay would have PLOTTED after the same calls (plan
   * 74.1-30, CR-01): the shown tiles, the retained shape on a red empty show, null when
   * cleared. The HELD PICTURE cases read it through `pictureKindAt`.
   */
  beltPreview: { on: boolean; cleared: number; tiles: TileView[] | null };
  /**
   * The held pictures of committed belts (plan 74.1-30): the lists the last
   * `showHeldBelts` call handed over, empty after `clearHeldBelts`, and how many times the
   * surface was emptied. The HELD PICTURE cases read them through `pictureKindAt`.
   */
  heldBelts: { pictures: TileView[][]; cleared: number };
  beltHandleCalls: Array<{ head: Pt; tail: Pt }>;
  beltHandlesCleared: { count: number };
  draggedHandleCalls: Pt[];
  draggedHandleCleared: { count: number };
  nubRingCalls: Array<{ pt: Pt; armed: boolean }>;
  nubRingCleared: { count: number };
  handleRingCalls: Pt[];
  handleRingCleared: { count: number };
  /** overlay.clearSelection() call count (67-REVIEW WR-02). */
  selectionCleared: { count: number };
  hoverRingCalls: Array<{ cx: number; cy: number }>;
  /** Configurable rotate-handle center (null = no node selected). */
  rotateCenter: { pt: Pt | null };
  /** setRotateHandleHover(on) call log. */
  rotateHoverCalls: boolean[];
  /** overlay.showPending(cell, dims) call log — the IX-05 neutral shimmer. */
  pendingCalls: Array<{
    cell: { cx: number; cy: number };
    dims: { w: number; h: number; rot: number };
  }>;
  /** overlay.clearPending() call count. */
  pendingCleared: { count: number };
  /** overlay.showRejectFlash(cell, dims) call log — the IX-05 fault flash. */
  rejectFlashCalls: Array<{
    cell: { cx: number; cy: number };
    dims: { w: number; h: number; rot: number };
  }>;
  /**
   * overlay.showWireTargets(pts) call log - the WIRE-05 resting affordance (66-06).
   * Each entry is a COPY of the point list, so a later repaint cannot retroactively
   * rewrite an earlier reading.
   */
  wireTargetCalls: Array<Array<{ x: number; y: number; filled: boolean }>>;
  /** overlay.clearWireTargets() call count. */
  wireTargetsCleared: { count: number };
  /**
   * overlay.showDockTargets(pts) call log - the LINK-02/LINK-10 belt affordance, the
   * same recorder shape as the wire one above and for the same reason: each entry is a
   * COPY, so a later repaint cannot retroactively rewrite an earlier reading.
   */
  dockTargetCalls: Array<Array<{ x: number; y: number; filled: boolean }>>;
  /** overlay.clearDockTargets() call count. */
  dockTargetsCleared: { count: number };
  /**
   * overlay.showRoute(path, valid) call log - the in-drag corridor preview.
   *
   * A REAL RECORDER AS OF PLAN 66-06, AND IT WAS A NO-OP BEFORE. `showRoute` was
   * stubbed `() => {}` here from the day this rig was written, so the E9 colour flip
   * (red over empty canvas, blue on an accepting nub) could not be witnessed by any
   * test in the repository - a gate asserting against it would have been asserting
   * against nothing. The path is COPIED per call for the same reason as above.
   */
  routeCalls: Array<{
    path: Array<{ cx: number; cy: number }>;
    /**
     * The corridor's two ENDS as the shipped code passed them (plan 75-05, D-08): the
     * pressed port's nub and the acquired port's nub, or `NO_NUB` (null) for the free
     * end. COPIED per call, as `path` is.
     */
    nubs: RecordedNubs;
    valid: boolean;
    lane: number;
    /**
     * The OTHER legs the same gesture will mint (D-04, plan 72-11). COPIED per call for
     * the same reason `path` is: a later repaint must not retroactively rewrite an
     * earlier reading.
     */
    pairedLegs: Array<{ path: Array<{ cx: number; cy: number }>; lane: number; nubs: RecordedNubs }>;
    /**
     * The KEY SET of each paired leg AS THE SHIPPED CODE PASSED IT, snapshotted at call
     * time.
     *
     * ADDED 2026-09-04 (phase 72 vacuity sweep, V-3), and the reason is the whole point
     * of it. `pairedLegs` above is REBUILT here as `{ path, lane }`, so a test reading
     * `Object.keys(call.pairedLegs[0])` was reading THIS RECORDER'S shape and not the
     * overlay payload. The old comment on that field claimed a later edit that tinted
     * one leg "has to change this shape to land"; it does not, because the rebuild
     * silently drops any field it does not name. MEASURED: passing
     * `[Object.assign({ reply: true }, pair.leg)]` from `gestures.ts` left the R-70
     * ghost-parity test green.
     *
     * Keys are read off the ARGUMENT, so an added field is visible; they are copied
     * into a new array at call time, so a later repaint still cannot rewrite an earlier
     * reading. Both properties at once, which the rebuild could not give.
     */
    pairedLegKeys: string[][];
    /**
     * How many arguments `showRoute` was actually called with. The forward leg does not
     * reach the overlay as an object at all - it is `path` and `lane` as positional
     * arguments under the ONE shared `valid` flag - so its "field set" is the call's
     * arity, and a fifth argument carrying per-leg colour, role or direction is a red.
     */
    argCount: number;
  }>;
  /** overlay.clearRoute() call count. */
  routeCleared: { count: number };
  /**
   * CONNECT-02: the mutable answer `overlay.alertRingsActive()` returns.
   *
   * A REAL, FLIPPABLE FLAG rather than a constant `true`, because the whole
   * point of the gate is that it can go false while the app is running: a
   * structural edit fires `overlay.clearAlertRings()`, which nulls the birth
   * stamp this reads. (Until 2026-08-30 a 5000ms TTL inside `overlay.tick`
   * could flip it too; that clock was retired - the ring persists until the
   * strand is RESOLVED - so a structural edit is now the only flipper.) A rig
   * that hard-coded `true` could not witness the clear-vs-drag race at all.
   * Defaults to `true` so a case that pushes a ring set gets a pressable ring
   * without extra ceremony.
   */
  alertRings: {
    active: boolean;
    /** Drive `clearAlertRingAt` to answer "no ring here" (67-REVIEW WR-03). */
    miss: boolean;
  };
  /** overlay.clearAlertRingAt(pt) call log - the CONNECT-02 press-side retire. */
  alertRingAtCleared: Pt[];
} {
  const ghostCalls: Array<{
    valid: boolean;
    dims?: { w: number; h: number; rot: number };
    ports?: GhostPortSpec[];
  }> = [];
  const ghostCleared = { count: 0 };
  const selections: number[] = [];
  const beltCalls: Array<{ tiles: TileView[]; valid: boolean }> = [];
  const beltPreview: { on: boolean; cleared: number; tiles: TileView[] | null } = {
    on: false,
    cleared: 0,
    tiles: null,
  };
  let beltPreviewLast: TileView[] | null = null;
  const heldBelts: { pictures: TileView[][]; cleared: number } = { pictures: [], cleared: 0 };
  const beltHandleCalls: Array<{ head: Pt; tail: Pt }> = [];
  const beltHandlesCleared = { count: 0 };
  const draggedHandleCalls: Pt[] = [];
  const draggedHandleCleared = { count: 0 };
  const nubRingCalls: Array<{ pt: Pt; armed: boolean }> = [];
  const nubRingCleared = { count: 0 };
  const handleRingCalls: Pt[] = [];
  const handleRingCleared = { count: 0 };
  const selectionCleared = { count: 0 };
  const hoverRingCalls: Array<{ cx: number; cy: number }> = [];
  const rotateCenter: { pt: Pt | null } = { pt: null };
  const rotateHoverCalls: boolean[] = [];
  const pendingCalls: Array<{
    cell: { cx: number; cy: number };
    dims: { w: number; h: number; rot: number };
  }> = [];
  const pendingCleared = { count: 0 };
  const rejectFlashCalls: Array<{
    cell: { cx: number; cy: number };
    dims: { w: number; h: number; rot: number };
  }> = [];
  const wireTargetCalls: Array<Array<{ x: number; y: number; filled: boolean }>> = [];
  const wireTargetsCleared = { count: 0 };
  const dockTargetCalls: Array<Array<{ x: number; y: number; filled: boolean }>> = [];
  const dockTargetsCleared = { count: 0 };
  const routeCalls: Array<{
    path: Array<{ cx: number; cy: number }>;
    nubs: RecordedNubs;
    valid: boolean;
    lane: number;
    pairedLegs: Array<{ path: Array<{ cx: number; cy: number }>; lane: number; nubs: RecordedNubs }>;
    pairedLegKeys: string[][];
    argCount: number;
  }> = [];
  const routeCleared = { count: 0 };
  const alertRings = { active: true, miss: false };
  const alertRingAtCleared: Pt[] = [];
  return {
    alertRings,
    alertRingAtCleared,
    rotateCenter,
    rotateHoverCalls,
    pendingCalls,
    pendingCleared,
    rejectFlashCalls,
    wireTargetCalls,
    wireTargetsCleared,
    dockTargetCalls,
    dockTargetsCleared,
    routeCalls,
    routeCleared,
    ghostCalls,
    ghostCleared,
    selections,
    beltCalls,
    beltPreview,
    heldBelts,
    beltHandleCalls,
    beltHandlesCleared,
    draggedHandleCalls,
    draggedHandleCleared,
    nubRingCalls,
    nubRingCleared,
    handleRingCalls,
    handleRingCleared,
    selectionCleared,
    hoverRingCalls,
    showGhost: (_cell, valid, dims, ports) => {
      ghostCalls.push({ valid, dims, ports });
    },
    clearGhost: () => {
      ghostCleared.count++;
    },
    // A REST SIGNATURE so `args.length` is readable (an arrow function has no
    // `arguments`). The five names are destructured out of it with the shipped defaults.
    // `nubs` is second and REQUIRED since plan 75-05 (D-08), so it has no default here
    // either: a call that omitted it would record `undefined` and redden the nub cases.
    showRoute: (...args) => {
      const [path, nubs, valid = true, lane = 0, pairedLegs = []] = args;
      // `lane` recorded as of plan 66-08. Without it nothing could witness that the
      // ghost sits in the lane the landed cable will take - the preview would have
      // been free to promise a corridor the cable does not occupy, which is the exact
      // split that disqualified the `fabrico-command` corridor offset.
      routeCalls.push({
        path: path.map((c) => ({ cx: c.cx, cy: c.cy })),
        nubs: copyNubs(nubs),
        valid,
        lane,
        pairedLegs: pairedLegs.map((leg) => ({
          path: leg.path.map((c) => ({ cx: c.cx, cy: c.cy })),
          lane: leg.lane,
          nubs: copyNubs(leg.nubs),
        })),
        // Read off the ARGUMENT the shipped code passed, before the rebuild above
        // narrows it. See the field's docblock (V-3).
        pairedLegKeys: pairedLegs.map((leg) => Object.keys(leg).sort()),
        argCount: args.length,
      });
    },
    clearRoute: () => {
      routeCleared.count++;
    },
    showBeltPreview: (tiles, valid) => {
      beltCalls.push({ tiles, valid });
      beltPreview.on = tiles.length > 0 || !valid;
      if (tiles.length > 0) {
        beltPreviewLast = tiles;
        beltPreview.tiles = tiles;
      } else {
        beltPreview.tiles = !valid ? beltPreviewLast : null;
      }
    },
    clearBeltPreview: () => {
      beltPreview.on = false;
      beltPreview.cleared++;
      beltPreview.tiles = null;
      beltPreviewLast = null;
    },
    showHeldBelts: (pictures) => {
      heldBelts.pictures = pictures.map((p) => [...p]);
    },
    clearHeldBelts: () => {
      heldBelts.pictures = [];
      heldBelts.cleared++;
    },
    showSelection: (id) => {
      selections.push(id);
    },
    clearSelection: () => {
      selectionCleared.count++;
    },
    hoverRing: (cell) => {
      hoverRingCalls.push({ cx: cell.cx, cy: cell.cy });
    },
    clearHover: () => {},
    showBeltHandles: (head, tail) => {
      beltHandleCalls.push({ head, tail });
    },
    clearBeltHandles: () => {
      beltHandlesCleared.count++;
    },
    showHandleRing: (pt) => {
      handleRingCalls.push(pt);
    },
    clearHandleRing: () => {
      handleRingCleared.count++;
    },
    showDraggedHandle: (pt) => {
      draggedHandleCalls.push(pt);
    },
    clearDraggedHandle: () => {
      draggedHandleCleared.count++;
    },
    showNubRing: (pt, armed) => {
      nubRingCalls.push({ pt, armed });
    },
    clearNubRing: () => {
      nubRingCleared.count++;
    },
    showWireTargets: (pts) => {
      wireTargetCalls.push(pts.map((p) => ({ x: p.x, y: p.y, filled: p.filled })));
    },
    clearWireTargets: () => {
      wireTargetsCleared.count++;
    },
    showDockTargets: (pts) => {
      dockTargetCalls.push(pts.map((p) => ({ x: p.x, y: p.y, filled: p.filled })));
    },
    clearDockTargets: () => {
      dockTargetsCleared.count++;
    },
    rotateHandleCenter: () => rotateCenter.pt,
    setRotateHandleHover: (on) => {
      rotateHoverCalls.push(on);
    },
    showPending: (cell, dims) => {
      pendingCalls.push({ cell: { cx: cell.cx, cy: cell.cy }, dims });
    },
    clearPending: () => {
      pendingCleared.count++;
    },
    showRejectFlash: (cell, dims) => {
      rejectFlashCalls.push({ cell: { cx: cell.cx, cy: cell.cy }, dims });
    },
    alertRingsActive: () => alertRings.active,
    clearAlertRingAt: (pt) => {
      alertRingAtCleared.push({ x: pt.x, y: pt.y });
      // Mirrors the real overlay's answer (67-REVIEW WR-03): a retire reports
      // whether it found a ring. `alertRings.miss` lets a case drive the MISS.
      return !alertRings.miss;
    },
  };
}

interface DeleteWithItemsCall {
  handle: number;
  count: number;
  kind: 'belt' | 'machine';
  beltIds: number[];
}

/**
 * One host verdict for one gesture, in the shape plan 88-03 puts on the wire (phase 88, D-06).
 * `seq` is the gesture's id as the CLIENT assigned it: in this rig, the 1-based index of its
 * frame in `sent` (the id the rig's `sendInput` returns to the controller).
 */
type RigVerdict =
  | { kind: 'gestureRefused'; seq: number; tag: string; cmd?: string; node?: number }
  | { kind: 'gestureAccepted'; seq: number; generation: number; minted: number[] }
  | { kind: 'gestureDiscarded'; seq: number };

interface Rig {
  win: Bus;
  canvas: Bus;
  /**
   * Every pointer-capture call the controller made on the fake canvas, in order (phase 89,
   * plan 89-01, for BELT-08's W245 and W253 probes). A real canvas has `setPointerCapture`,
   * `releasePointerCapture` and `hasPointerCapture`; this node rig had none, so a controller
   * that captures its pointer (plan 89-07) would throw here. No shipped code calls them before
   * plan 89-07.
   */
  captureCalls: Array<{ op: 'set' | 'release'; pointerId: number }>;
  overlay: ReturnType<typeof makeOverlay>;
  scene: SceneState;
  sent: Uint8Array[];
  /**
   * The `opts` each `sendInput` call carried, index for index with `sent` (phase 88, plan
   * 88-05): a follow-up addressed to a handle an accept named carries that accept's
   * `generation`; a gesture made from what is on screen carries none.
   */
  sentOpts: Array<{ generation?: number; quiet?: boolean } | undefined>;
  /** The claim each `sendInput` call carried, index for index with `sent` (plan 88-07). */
  sentClaims: Array<QueuedClaim | undefined>;
  /** The claims store installed on `scene`, as App installs its own (plan 88-07, D-09). */
  claims: QueuedClaims;
  /**
   * Hand the controller the host's verdict for one gesture (phase 88, plan 88-01), through
   * the controller's `onVerdict` (plan 88-05).
   */
  verdict: (v: RigVerdict) => void;
  /**
   * The host accepted gesture `gestureId` and it minted `minted` in the handle table of
   * `generation` (plan 88-05). `gestureId` is the 1-based index of its frame in `sent`.
   */
  accept: (gestureId: number, minted: number[], generation?: number) => void;
  /** The host refused gesture `gestureId` with refusal `tag` (plan 88-05). */
  refuse: (gestureId: number, tag: string) => void;
  /**
   * Whether the sim is playing, as the controller reads it through its `isPlaying`
   * dependency (phase 88, D-07). Default true.
   */
  setPlaying: (on: boolean) => void;
  /** The sim resumed at `tick`: App's `setPlayingNow` call into the controller (D-07). */
  resume: (tick: number) => void;
  begin: (kind: number) => void;
  /** Arm a ROUTE-06 Router preset by seeded medium (Electrical=1, Mechanical=0). */
  beginRouterPreset: (medium: number) => void;
  commit: (handle: number) => void;
  /** The shared delete-decision path (IX-04): guard-then-one-commitDelete. */
  requestDelete: (handle: number) => void;
  deleteWithItems: DeleteWithItemsCall[];
  panState: { enabled: boolean };
  armBelt: () => void;
  /** Arm the palette Wire tool (WIRE-02/WIRE-05). */
  armWire: () => void;
  destroy: () => void;
  /** Undo/Redo dep-callback invocation counts (the keybinding targets). */
  counts: { undo: number; redo: number };
  /** IX-07/ONB-01: the lowest-priority Escape fallback invocation count. */
  escapeFallback: { count: number };
  /** Every `deps.onClientRefusal(tag)` the controller fired, in order (plan 75-07, D-12). */
  clientRefusals: ClientRefusalTag[];
  /** Mutable modal-open flag the controller reads via isModalOpen. */
  modal: { open: boolean };
  /** Mutable flag the controller reads via isSimStopped (phase 90, FAIL-01). Default false. */
  simStopped: { on: boolean };
  /** Call counts of the transport and file deps the keys reach (phase 90, FAIL-01). */
  calls: { play: number; step: number; save: number; newBoard: number; open: number };
  /** The `saveAs` argument of every `deps.onSave` call, in order (phase 91, D-11). */
  saveArgs: Array<boolean | undefined>;
  /** The controller's stop teardown (phase 90, FAIL-01). */
  standDown: () => void;
  /** The controller's live selection handle (null when cleared). */
  selectedId: () => number | null;
  /** Every `deps.onSelect(id)` the controller fired, in order (67-REVIEW WR-02). */
  onSelectCalls: Array<number | null>;
  /** Every `deps.onSelectBelt(id)` the controller fired, in order (BELT-01). */
  onSelectBeltCalls: Array<number | null>;
  /** Every `onLabelPlaced` call (phase 76, plan 76-02). */
  onLabelPlacedCalls: number[];
  /** Drive the keyframe selection-clear path (App calls this after a full keyframe). */
  clearSel: () => void;
  /**
   * Tell the controller a swap's keyframe (New, Open, an example, a Load) was applied: App
   * calls this where it clears the queued claims, before `clearSel` (phase 88, T-88-11).
   */
  swap: () => void;
  /** What the controller is still waiting on (phase 88 review, IN-05). */
  waiting: () => { placements: number; belts: number; docks: number };
  /** Drive the echo selection-refresh path (App calls this on diff packets, WR-01/WR-02). */
  refreshSel: (placedNodeIds: number[], emittedBeltIds?: number[]) => void;
  /** Drive the CONNECT-02 stranded-ring channel (App calls this from the packet handler). */
  setStrandedRings: (rings: readonly StrandedRing[]) => void;
  /** The live canvas cursor value (the controller drives canvas.style.cursor). */
  cursor: () => string;
  /** onArmedChange callback log — the armed-tool state surfaced to React (IX-03). */
  armedCalls: Array<
    | { kind: 'machine'; machineKind: number; presetMedium?: number | null }
    | { kind: 'belt' }
    | { kind: 'wire' }
    | null
  >;
  /**
   * Run every rAF callback queued at call time (a callback that re-schedules
   * itself lands in the NEXT flush) — drives the echo watchers deterministically.
   */
  flushRaf: () => void;
  /**
   * The rig's OWN camera shim, exposed for the single case that asserts the rig
   * (`both rig cell mappings agree with their own frac mapping`, 74-14). Nothing
   * else in this file should read it: every other case asserts the CONTROLLER's
   * behaviour through the shim, not the shim itself.
   */
  cam: {
    screenToCell: (sx: number, sy: number) => { cx: number; cy: number };
    screenToCellFrac: (sx: number, sy: number) => { fx: number; fy: number };
  };
}

/**
 * Rig options (plan 66-06).
 *
 * `cellsFromWorld` swaps the legacy `cell = floor(screen)` shim for the REAL
 * `cell = floor(world / CELL)` mapping. The legacy shim is deliberately inconsistent
 * with the identity world shim beside it - "handle/nub hit-tests read WORLD px; cell
 * hit-tests keep the floor()" - which is harmless for every gesture that reads only
 * one of the two, and impossible for the wire in-drag preview, which reads BOTH: it
 * routes from the source port's CELL to either the pointer's CELL or the target nub's
 * CELL, having found that nub in WORLD px. Under the legacy shim a pointer sitting on
 * a nub at world (194,176) reports cell (194,176) while the nub's own cell is (6,5),
 * so "the same corridor, red then blue" could not be stated, let alone asserted.
 */
interface RigOpts {
  cellsFromWorld?: boolean;
  /**
   * The camera scale (plan 74.1-15), default 1. Screen = world * scale, so a world-px
   * hit radius shrinks on screen as the camera zooms out. Only meaningful together with
   * `cellsFromWorld`; at the default the shim is byte-identical to the identity rig.
   */
  scale?: number;
  /**
   * The send seam has no transport (phase 88 review, IN-05): every send is recorded in `sent`
   * as an attempt and returns 0, the id App's `submitInput` returns when nothing was sent.
   */
  noTransport?: boolean;
}

/** The legacy rig: `cell = floor(screen)`. Every pre-66-06 case reads this. */
function setupRig(...nodes: NodeView[]): Rig {
  return setupRigWith({}, ...nodes);
}

function setupRigWith(opts: RigOpts, ...nodes: NodeView[]): Rig {
  const win = makeBus();
  // The controller references the GLOBAL window + rAF; install bus-backed shims.
  // rAF is a manually-flushable queue (never auto-runs): the echo watchers are
  // driven deterministically via rig.flushRaf(); cancel removes the callback.
  (globalThis as unknown as { window: Bus }).window = win;
  const rafCbs = new Map<number, FrameRequestCallback>();
  let rafId = 0;
  (globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame =
    (cb: FrameRequestCallback) => {
      rafCbs.set(++rafId, cb);
      return rafId;
    };
  (globalThis as unknown as { cancelAnimationFrame: (h: number) => void }).cancelAnimationFrame =
    (h: number) => {
      rafCbs.delete(h);
    };

  const canvas = makeBus();
  // The pointer-capture surface a real canvas has (phase 89, plan 89-01): recording stubs, so
  // a case can read which pointer a draw captured and released (see `Rig.captureCalls`).
  const captureCalls: Array<{ op: 'set' | 'release'; pointerId: number }> = [];
  const captured = new Set<number>();
  Object.assign(canvas, {
    setPointerCapture: (pointerId: number): void => {
      captureCalls.push({ op: 'set', pointerId });
      captured.add(pointerId);
    },
    releasePointerCapture: (pointerId: number): void => {
      captureCalls.push({ op: 'release', pointerId });
      captured.delete(pointerId);
    },
    hasPointerCapture: (pointerId: number): boolean => captured.has(pointerId),
  });
  // toLocal() uses getBoundingClientRect → origin (0,0) so client == local.
  (canvas as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
    () => ({ left: 0, top: 0 }) as DOMRect;
  // Cursor spy: the controller drives canvas.style.cursor ('pointer' over a
  // belt handle, 'grabbing' mid-drag) — the shim records the live value.
  const style = { cursor: '' };
  (canvas as unknown as { style: { cursor: string } }).style = style;

  const scene = createSceneState();
  for (const n of nodes) {
    scene.nodes.set(n.id, n);
  }

  const overlay = makeOverlay();
  const sent: Uint8Array[] = [];
  const sentOpts: Array<{ generation?: number; quiet?: boolean } | undefined> = [];
  // Phase 88, plan 88-07 (D-09): the claims store App owns, installed on the scene exactly as
  // App installs it, fed by the rig's send seam, verdicts, Resume and frames as App feeds it.
  const claims = createQueuedClaims();
  scene.queuedClaims = claims;
  const sentClaims: Array<QueuedClaim | undefined> = [];
  const deleteWithItems: DeleteWithItemsCall[] = [];
  const onSelectCalls: Array<number | null> = [];
  const onSelectBeltCalls: Array<number | null> = [];
  const onLabelPlacedCalls: number[] = [];
  const panState = { enabled: true };
  const counts = { undo: 0, redo: 0 };
  // IX-07/ONB-01: the lowest-priority Escape fallback call count (kept SEPARATE
  // from `counts` so the strict undo/redo toEqual assertions stay untouched).
  const escapeFallback = { count: 0 };
  const clientRefusals: ClientRefusalTag[] = [];
  const modal = { open: false };
  const simStopped = { on: false };
  const calls = { play: 0, step: 0, save: 0, newBoard: 0, open: 0 };
  const saveArgs: Array<boolean | undefined> = [];
  const armedCalls: Array<
    | { kind: 'machine'; machineKind: number; presetMedium?: number | null }
    | { kind: 'belt' }
    | { kind: 'wire' }
    | null
  > = [];

  const sc = opts.scale ?? 1;
  const cam = {
    // Identity-ish: cell = floor(screen) so a click at (c+0.5) lands in cell c.
    // Under `cellsFromWorld` it is the real mapping instead (see RigOpts).
    screenToCell: (sx: number, sy: number) =>
      opts.cellsFromWorld
        ? { cx: Math.floor(sx / sc / CELL), cy: Math.floor(sy / sc / CELL) }
        : { cx: Math.floor(sx), cy: Math.floor(sy) },
    // The FRACTIONAL pair (74-14), mirroring BOTH modes above exactly so the floor
    // of this is that. The belt accumulator's segment walk reads this one, so a
    // shim that disagreed with its own integer mapping would leave every walk case
    // in this file measuring the rig. `both rig cell mappings agree with their own
    // frac mapping` asserts the agreement rather than trusting this comment.
    // The divisor is CELL, never a bare 32.
    screenToCellFrac: (sx: number, sy: number) =>
      opts.cellsFromWorld ? { fx: sx / sc / CELL, fy: sy / sc / CELL } : { fx: sx, fy: sy },
    // Identity world<->screen by default (scale 1, so nubHitRadiusWorld = 12). Handle /
    // nub hit-tests read WORLD px; cell hit-tests keep the floor() shim above. `scale`
    // (plan 74.1-15) multiplies world into screen.
    screenToWorld: (sx: number, sy: number) => ({ x: sx / sc, y: sy / sc }),
    worldToScreen: (wx: number, wy: number) => ({ x: wx * sc, y: wy * sc }),
    setPanEnabled: (on: boolean) => {
      panState.enabled = on;
    },
  };

  // Phase 88 (D-07): the play state the controller's one remaining timer reads.
  const playing = { on: true };
  const ctrl = createGestureController({
    isPlaying: () => playing.on,
    canvas: canvas as unknown as HTMLCanvasElement,
    cam: cam as never,
    overlay,
    getScene: () => scene,
    // The gesture id App's send seam would return: the frame's 1-based index in `sent`. The
    // seam takes `opts.claim` (plan 88-07) and registers it, as App's `submitInput` does;
    // `sentOpts` records the rest, so the generation each frame carries reads as before.
    sendInput: (b, o) => {
      const { claim, ...rest } = o ?? {};
      sentOpts.push(o === undefined || Object.keys(rest).length === 0 ? undefined : rest);
      sentClaims.push(claim);
      sent.push(b);
      if (opts.noTransport) {
        return 0;
      }
      if (claim !== undefined) {
        // The frame's generation, as App's seam stamps it: the one the caller named, else the
        // scene's (phase 88 review, WR-01).
        claims.add(sent.length, claim, { generation: rest.generation ?? scene.generation, tick: scene.tick });
      }
      return sent.length;
    },
    onDeleteWithItems: (handle, count, kind, beltIds) => {
      deleteWithItems.push({ handle, count, kind, beltIds });
    },
    onSelect: (id) => {
      onSelectCalls.push(id);
    },
    onSelectBelt: (id) => {
      onSelectBeltCalls.push(id);
    },
    onLabelPlaced: (id) => {
      onLabelPlacedCalls.push(id);
    },
    onUndo: () => {
      counts.undo++;
    },
    onRedo: () => {
      counts.redo++;
    },
    onArmedChange: (tool) => {
      armedCalls.push(tool);
    },
    isModalOpen: () => modal.open,
    isSimStopped: () => simStopped.on,
    onTogglePlay: () => {
      calls.play++;
    },
    onStep: () => {
      calls.step++;
    },
    onSave: (saveAs) => {
      calls.save++;
      saveArgs.push(saveAs);
    },
    onNew: () => {
      calls.newBoard++;
    },
    onOpen: () => {
      calls.open++;
    },
    onEscapeFallback: () => {
      escapeFallback.count++;
    },
    onClientRefusal: (tag) => {
      clientRefusals.push(tag);
    },
  });

  return {
    win,
    canvas,
    captureCalls,
    overlay,
    scene,
    sent,
    sentOpts,
    sentClaims,
    claims,
    verdict: (v) => {
      claims.onVerdict(v as GestureVerdict, scene);
      ctrl.onVerdict(v as GestureVerdict);
    },
    accept: (gestureId, minted, generation = 0) => {
      const v: GestureVerdict = { kind: 'gestureAccepted', seq: gestureId, generation, minted };
      claims.onVerdict(v, scene);
      ctrl.onVerdict(v);
    },
    refuse: (gestureId, tag) => {
      const v = { kind: 'gestureRefused', seq: gestureId, tag } as GestureVerdict;
      claims.onVerdict(v, scene);
      ctrl.onVerdict(v);
    },
    setPlaying: (on) => {
      playing.on = on;
    },
    resume: (tick) => {
      claims.onResume(tick);
      ctrl.onResume(tick);
    },
    cam,
    deleteWithItems,
    panState,
    counts,
    escapeFallback,
    clientRefusals,
    modal,
    simStopped,
    calls,
    saveArgs,
    standDown: () => ctrl.standDown(),
    begin: (kind) => ctrl.beginPlacement(kind),
    beginRouterPreset: (medium) => ctrl.beginRouterPreset(medium),
    armBelt: () => ctrl.armBeltDraw(),
    armWire: () => ctrl.armWireDraw(),
    commit: (handle) => ctrl.commitDelete(handle),
    requestDelete: (handle) => ctrl.requestDelete(handle),
    selectedId: () => ctrl.selectedId(),
    onSelectCalls,
    onSelectBeltCalls,
    onLabelPlacedCalls,
    clearSel: () => ctrl.clearSelection(),
    // Optional call, so the case that drives it reads red (not a TypeError) on a controller
    // without the hook.
    swap: () => (ctrl as Partial<GestureController>).onSwap?.(),
    waiting: () => ctrl.waiting(),
    refreshSel: (placedNodeIds, emittedBeltIds = []) =>
      ctrl.refreshSelection(placedNodeIds, emittedBeltIds),
    setStrandedRings: (rings) => ctrl.setStrandedRings(rings),
    cursor: () => style.cursor,
    armedCalls,
    flushRaf: () => {
      // A flush stands for a frame after a packet: the claims hear the packet first, as App's
      // packet path feeds them before the next frame (plan 88-07).
      claims.onPacket(scene, playing.on);
      const cbs = [...rafCbs.values()];
      rafCbs.clear();
      for (const cb of cbs) {
        cb(0);
      }
    },
    destroy: () => ctrl.destroy(),
  };
}

/** Centre-of-cell client point (origin-0 rect → client == local). */
const at = (cx: number, cy: number) => ({ clientX: cx + 0.5, clientY: cy + 0.5 });

/** A DrawBelt's wire discriminant (`encodeGridCommand`), the first byte of its frame. */
const DRAW_BELT_DISC = 3;

/**
 * The gesture ids of every DrawBelt the rig sent, in send order: the 1-based index of its frame
 * in `sent`, which is what the rig's `sendInput` returns (plan 88-06).
 */
function drawIds(r: Rig): number[] {
  return r.sent.flatMap((f, i) => (f[0] === DRAW_BELT_DISC ? [i + 1] : []));
}

/**
 * A PREDICTED-ILLEGAL SEND (phase 89, plan 89-09, D-13, FAIL-02). Until this plan an illegal belt
 * release sent nothing; since it, every release with cells is sent, and an illegal one is ONE
 * DrawBelt carrying the cells the last preview painted, with NO claim, no held picture and no
 * follow-up, so the host's typed refusal says why. Asserts exactly that for the frames sent
 * since `before` and returns the one frame.
 */
function expectIllegalDrawSent(r: Rig, what: string, before = 0): Uint8Array {
  const frames = r.sent.slice(before);
  expect(frames, `${what}: the release is sent as ONE frame (D-13), never swallowed`).toHaveLength(1);
  expect(frames[0][0], `${what}: and that frame is a DrawBelt`).toBe(DRAW_BELT_DISC);
  expect(r.sentClaims[before], `${what}: a predicted-illegal send carries no claim`).toBeUndefined();
  expect(r.overlay.heldBelts.pictures, `${what}: and arms no held picture`).toEqual([]);
  return frames[0];
}

/**
 * The host accepts DrawBelt number `nth` (0-based in send order; negative counts from the
 * last, default the last) and names `belt` as the belt it minted, in the table of
 * `generation` (phase 88, D-06). A held belt's owed Docks go out only once this accept and a
 * packet holding `belt` are both in (plan 88-06), so every case that echoes a drawn belt and
 * expects its Docks delivers the accept too.
 */
function acceptDraw(r: Rig, belt: number, nth = -1, generation = 0): void {
  const id = drawIds(r).at(nth);
  if (id === undefined) {
    throw new Error(`acceptDraw: no DrawBelt number ${nth} was sent`);
  }
  r.accept(id, [belt], generation);
}

let rig: Rig | undefined;
afterEach(() => {
  rig?.destroy();
  rig = undefined;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The rig's own camera shim, asserted once (plan 74-14)
// ---------------------------------------------------------------------------
//
// `:5645` warns that re-asserting the rig's cell mapping would be testing the rig,
// and that warning is right for every OTHER case in this file. This one case earns
// the exception, and here is the exception in one line: the belt accumulator's
// segment walk reads `screenToCellFrac`, so if the rig's frac mapping disagreed with
// the rig's own `screenToCell` in either mode, every walk case in this file would be
// measuring the shim rather than the accumulator and would still be green.
describe('the vitest rig camera shim (74-14)', () => {
  it('both rig cell mappings agree with their own frac mapping', () => {
    const samples: Array<[number, number]> = [
      [0, 0],
      // A sub-cell offset in BOTH modes: a quarter of a legacy cell and a quarter
      // of a real CELL, so neither mode is exercised only at integer points.
      [0.25, 0.75],
      [CELL * 3 + CELL / 4, CELL * 5 + CELL / 2],
      [3.5, 5.5],
      // A negative coordinate, where Math.floor and truncation disagree.
      [-0.5, -1.5],
      [-CELL - 1, -CELL * 2 - 1],
    ];

    for (const cellsFromWorld of [false, true]) {
      const r = setupRigWith({ cellsFromWorld });
      try {
        let sawFractional = false;
        let sawNegative = false;
        for (const [sx, sy] of samples) {
          const frac = r.cam.screenToCellFrac(sx, sy);
          const cell = r.cam.screenToCell(sx, sy);
          const where = `cellsFromWorld=${cellsFromWorld} sample=(${sx},${sy})`;
          expect(Math.floor(frac.fx), `fx floors to cx at ${where}`).toBe(cell.cx);
          expect(Math.floor(frac.fy), `fy floors to cy at ${where}`).toBe(cell.cy);
          if (!Number.isInteger(frac.fx) || !Number.isInteger(frac.fy)) sawFractional = true;
          if (cell.cx < 0 || cell.cy < 0) sawNegative = true;
        }
        expect(sawFractional, `a sub-cell offset was reached (cellsFromWorld=${cellsFromWorld})`).toBe(
          true,
        );
        expect(sawNegative, `a negative cell was reached (cellsFromWorld=${cellsFromWorld})`).toBe(
          true,
        );
        // THE UNIT ARM, for the same reason the camera case carries one: the floor
        // identity above is satisfied by a shim answering in ANY unit, so on its own
        // it could not catch a frac mapping that had drifted off cells. One cell of
        // screen distance in THIS mode must move `fx` by exactly 1, and the step is
        // derived from the mode rather than written twice. MEASURED to bite: a rig
        // shim returning world px in the `cellsFromWorld` mode reddens here.
        const step = cellsFromWorld ? CELL : 1;
        const u0 = r.cam.screenToCellFrac(9, 13);
        const u1 = r.cam.screenToCellFrac(9 + step, 13 + step);
        expect(u1.fx - u0.fx, `fx counts CELLS (cellsFromWorld=${cellsFromWorld})`).toBeCloseTo(1, 9);
        expect(u1.fy - u0.fy, `fy counts CELLS (cellsFromWorld=${cellsFromWorld})`).toBeCloseTo(1, 9);
      } finally {
        r.destroy();
      }
    }
  });
});

describe('Rotate gesture (R / Shift+R)', () => {
  it('select + r emits exactly one Rotate (disc 2, ccw=false)', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    // Select the node: press-then-release with no drag.
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(2, 2) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(2, 2) });
    expect(rig.overlay.selections).toEqual([7]);

    rig.win.fire('keydown', { key: 'r', shiftKey: false, preventDefault: () => {} });

    expect(rig.sent).toHaveLength(1);
    // Rotate is disc 2 after the 17-02 Wire removal renumber (was 3).
    expect(rig.sent[0][0]).toBe(2); // Rotate discriminant
    expect(rig.sent[0][rig.sent[0].length - 1]).toBe(0); // ccw byte = false
  });

  it('Shift+R emits Rotate with ccw=true', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(2, 2) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(2, 2) });

    rig.win.fire('keydown', { key: 'R', shiftKey: true, preventDefault: () => {} });

    expect(rig.sent).toHaveLength(1);
    expect(rig.sent[0][0]).toBe(2); // Rotate discriminant (17-02 renumber)
    expect(rig.sent[0][rig.sent[0].length - 1]).toBe(1); // ccw byte = true
  });

  it('r with no selection and no placement emits nothing', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    rig.win.fire('keydown', { key: 'r', shiftKey: false, preventDefault: () => {} });
    expect(rig.sent).toHaveLength(0);
  });
});

// ===========================================================================
// Plan 74.1-18 (review WR-03, the maintainers' "Refuse, say why"): the WHERE of a Rotate the
// host will refuse because the turned box covers a belt.
// ===========================================================================
//
// The board is WR-03's: a catalog Router (2x3) at (10,10), so a turn either way makes
// the 3x2 box x 10..12, y 10..11, walked row-major (the host's `cells_of_footprint`
// order, mirrored by `cellsOfFootprint`): (10,10) (11,10) (12,10) (10,11) (11,11) (12,11).
// The Router's own cells are skipped, as the host skips them. The first other occupant
// decides: a belt tile there earns the reject flash on THAT tile (the host answers
// `RotateCoversBelt` in words); a machine there, or nothing, earns no flash. The Rotate
// is SENT every time (Phase 64 D-07: the host is the judge).
describe('R on a machine whose turn would cover a belt: the flash says which belt (plan 74.1-18)', () => {
  const tile = (cx: number, cy: number): TileView => ({
    cell_x: cx,
    cell_y: cy,
    kind: { Straight: { axis: 0 } },
  });
  const beltOn = (id: number, cells: Array<[number, number]>): BeltView => ({
    id,
    latency: 1,
    fill: 0,
    items: [],
    tiles: cells.map(([x, y]) => tile(x, y)),
    docks: [],
    ticks_per_slot: 1,
  });
  const router = (): NodeView => node({ id: 7, kind: machine_kind.ROUTER, cell_x: 10, cell_y: 10, w: 2, h: 3 });
  /** Select the Router with a click on its anchor, then press r (or Shift+R). */
  const pressR = (r: Rig, ccw: boolean): void => {
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...at(10, 10) });
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...at(10, 10) });
    expect(r.overlay.selections, 'the Router is selected').toEqual([7]);
    r.win.fire('keydown', { key: ccw ? 'R' : 'r', shiftKey: ccw, preventDefault: () => {} });
    expect(r.sent, 'exactly one Rotate is SENT either way (D-07)').toHaveLength(1);
    expect(r.sent[0][0]).toBe(2); // Rotate discriminant
  };

  it('the belt on the first output: r flashes that belt\'s first tile, (12,11), and still sends the Rotate', () => {
    rig = setupRig(router());
    rig.scene.belts.set(30, beltOn(30, [[12, 11], [13, 11]]));
    pressR(rig, false);
    expect(rig.overlay.rejectFlashCalls).toEqual([{ cell: { cx: 12, cy: 11 }, dims: { w: 1, h: 1, rot: 0 } }]);
  });

  it('Shift+R turns the same box the other way and flashes the same tile', () => {
    rig = setupRig(router());
    rig.scene.belts.set(30, beltOn(30, [[12, 11], [13, 11]]));
    pressR(rig, true);
    expect(rig.overlay.rejectFlashCalls).toEqual([{ cell: { cx: 12, cy: 11 }, dims: { w: 1, h: 1, rot: 0 } }]);
  });

  it('a MACHINE met first in the walk earns no flash (the host keeps FootprintCollision), even with the belt behind it', () => {
    rig = setupRig(router(), node({ id: 8, cell_x: 12, cell_y: 10 }));
    rig.scene.belts.set(30, beltOn(30, [[12, 11], [13, 11]]));
    pressR(rig, false);
    expect(rig.overlay.rejectFlashCalls).toEqual([]);
  });

  it('nothing in the way (the belt on the second output, outside the box): no flash', () => {
    rig = setupRig(router());
    rig.scene.belts.set(30, beltOn(30, [[12, 12], [13, 12]]));
    pressR(rig, false);
    expect(rig.overlay.rejectFlashCalls).toEqual([]);
  });

  it('with two belts in the box, the first in the HOST\'s row-major walk is the one flashed', () => {
    // Belt 30 is inserted FIRST into the scene and sits on (12,11); belt 31 sits on
    // (12,10). Row-major meets y=10 before y=11, so the host's first foreign cell is
    // (12,10), and the flash must land there, not on the belt the scene lists first.
    rig = setupRig(router());
    rig.scene.belts.set(30, beltOn(30, [[12, 11], [13, 11]]));
    rig.scene.belts.set(31, beltOn(31, [[12, 10], [13, 10]]));
    pressR(rig, false);
    expect(rig.overlay.rejectFlashCalls).toEqual([{ cell: { cx: 12, cy: 10 }, dims: { w: 1, h: 1, rot: 0 } }]);
  });

  // ---- the ROTATE HANDLE takes the same path (plan 74.1-25, review WR-04) -------------
  //
  // One `sendRotate(node, ccw)` sends the Rotate and runs the walk plus the flash; the R
  // key and the rotate-handle release both call it. Before this plan the handle sent the
  // frame and flashed nothing, so "Move that belt first." pointed at no belt.
  const HANDLE: Pt = { x: 400, y: 300 };
  /** Select the Router, park its rotate handle at HANDLE, click it (Shift for CCW). */
  const clickHandle = (r: Rig, ccw: boolean): void => {
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...at(10, 10) });
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...at(10, 10) });
    expect(r.overlay.selections, 'the Router is selected').toEqual([7]);
    r.overlay.rotateCenter.pt = HANDLE;
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, clientX: HANDLE.x + 4, clientY: HANDLE.y });
    r.win.fire('pointerup', { button: 0, shiftKey: ccw, target: r.canvas, clientX: HANDLE.x + 4, clientY: HANDLE.y });
    expect(r.sent, 'exactly one Rotate is SENT by the handle (D-07)').toHaveLength(1);
    expect([...r.sent[0]]).toEqual([...encodeGridCommand({ kind: 'Rotate', node: 7, ccw })]);
  };

  for (const ccw of [false, true]) {
    it(`the rotate handle${ccw ? ' with Shift' : ''} on a turn that meets the belt first flashes (12,11), as R does`, () => {
      rig = setupRig(router());
      rig.scene.belts.set(30, beltOn(30, [[12, 11], [13, 11]]));
      clickHandle(rig, ccw);
      expect(rig.overlay.rejectFlashCalls).toEqual([{ cell: { cx: 12, cy: 11 }, dims: { w: 1, h: 1, rot: 0 } }]);
    });
  }

  it('the rotate handle on a turn that meets a MACHINE first, or nothing, flashes nothing', () => {
    rig = setupRig(router(), node({ id: 8, cell_x: 12, cell_y: 10 }));
    rig.scene.belts.set(30, beltOn(30, [[12, 11], [13, 11]]));
    clickHandle(rig, false);
    expect(rig.overlay.rejectFlashCalls, 'a machine first: no flash').toEqual([]);
    rig.destroy();
    rig = setupRig(router());
    rig.scene.belts.set(30, beltOn(30, [[12, 12], [13, 12]]));
    clickHandle(rig, false);
    expect(rig.overlay.rejectFlashCalls, 'nothing in the way: no flash').toEqual([]);
  });

  // ---- the turn the host is JUDGING (plan 74.1-25, the review's info line) -------------
  //
  // The flash used to predict from the last ECHOED rot. The gesture layer now remembers,
  // per node, the rot its last sent Rotate will produce, and walks the next turn from it.
  // A REFUSED turn produces no rot, so it is not remembered: the walk that predicts the
  // refusal is the same walk that decides whether there is a rot to remember.
  //
  // THE BOARD THE DIFFERENCE NEEDS IS CONSTRUCTED, and it has to be. The host keeps the
  // anchor, so a 2x3 box alternates between its two shapes: rot 0 and 2 cover x 10..11,
  // y 10..12; rot 1 and 3 cover x 10..12, y 10..11. A turn from the rot a pending Rotate
  // will produce walks back over cells the stale scene still shows the Router owning, so
  // on a real board nothing else can be there yet. Belt 32 is placed on (10,12), inside
  // the Router's rot-0 box, to make the two predictions answer differently.
  const pressROnly = (r: Rig, ccw = false): void => {
    r.win.fire('keydown', { key: ccw ? 'R' : 'r', shiftKey: ccw, preventDefault: () => {} });
  };
  const selectRouter = (r: Rig): void => {
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...at(10, 10) });
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...at(10, 10) });
  };

  it('two R presses before the first echo: the second walk starts from the rot the first will produce', () => {
    rig = setupRig(router());
    rig.scene.belts.set(32, beltOn(32, [[10, 12], [9, 12]]));
    selectRouter(rig);
    pressROnly(rig);
    expect(rig.overlay.rejectFlashCalls, 'the first turn (to rot 1) is clear: no flash').toEqual([]);
    // No echo: the scene still shows rot 0. The host will judge the second Rotate from
    // rot 1, walking the rot-2 box, whose first foreign cell holding a belt is (10,12).
    pressROnly(rig);
    expect(rig.sent, 'two Rotates sent').toHaveLength(2);
    expect(rig.overlay.rejectFlashCalls, 'the second flash is the turn the host judges').toEqual([
      { cell: { cx: 10, cy: 12 }, dims: { w: 1, h: 1, rot: 0 } },
    ]);
  });

  it('a REFUSED first turn produces no rot: two R presses on a blocked Router flash the belt both times', () => {
    // The natural board: the belt on the first output. The host refuses the first Rotate
    // (RotateCoversBelt), so it judges the second from rot 0 again and refuses it the same
    // way; remembering a rot the first turn never produced would flash nothing here.
    rig = setupRig(router());
    rig.scene.belts.set(30, beltOn(30, [[12, 11], [13, 11]]));
    selectRouter(rig);
    pressROnly(rig);
    pressROnly(rig);
    expect(rig.sent).toHaveLength(2);
    expect(rig.overlay.rejectFlashCalls).toEqual([
      { cell: { cx: 12, cy: 11 }, dims: { w: 1, h: 1, rot: 0 } },
      { cell: { cx: 12, cy: 11 }, dims: { w: 1, h: 1, rot: 0 } },
    ]);
  });

  it('the remembered rot is dropped after ECHO_TTL_TICKS, on a keyframe, and once the echo shows it', () => {
    const board = (): Rig => {
      const r = setupRig(router());
      r.scene.belts.set(32, beltOn(32, [[10, 12], [9, 12]]));
      selectRouter(r);
      pressROnly(r);
      return r;
    };
    // TTL: the first Rotate never echoes (120 ticks pass), so the second is walked from the
    // echoed rot 0 again: the rot-1 box is clear, no flash.
    rig = board();
    rig.scene.tick += 121;
    pressROnly(rig);
    expect(rig.overlay.rejectFlashCalls, 'after the TTL: walked from rot 0').toEqual([]);
    rig.destroy();
    // KEYFRAME: a keyframe drops the record (and the selection); reselect, press again.
    rig = board();
    rig.clearSel();
    selectRouter(rig);
    pressROnly(rig);
    expect(rig.overlay.rejectFlashCalls, 'after a keyframe: walked from rot 0').toEqual([]);
    rig.destroy();
    // ECHO: the packet shows the Router at rot 1, then (constructed) back at rot 0 with no
    // keyframe. The record was dropped when the echo matched, so the scene's rot 0 is read.
    rig = board();
    const n = rig.scene.nodes.get(7)!;
    rig.scene.nodes.set(7, { ...n, rot: 1 });
    rig.refreshSel([7]);
    rig.scene.nodes.set(7, { ...n, rot: 0 });
    pressROnly(rig);
    expect(rig.overlay.rejectFlashCalls, 'after the echo matched: walked from the scene').toEqual([]);
  });
});

// UNDO-04 keybindings + WR-01 selection clear. Ctrl/Cmd+Z = undo,
// +Shift = redo, Ctrl+Y = redo — all dispatched from onKey, after the modal /
// editable guards, each calling preventDefault. clearSelection drops the
// ephemeral selection on every keyframe (handles can be reused after a reset).
describe('Undo/Redo keybindings (UNDO-04)', () => {
  const key = (over: Record<string, unknown>) => ({
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault: () => {},
    ...over,
  });

  it('Ctrl+Z dispatches onUndo (no shift) and calls preventDefault', () => {
    rig = setupRig();
    let prevented = false;
    rig.win.fire(
      'keydown',
      key({ key: 'z', ctrlKey: true, preventDefault: () => { prevented = true; } }),
    );
    expect(rig.counts).toEqual({ undo: 1, redo: 0 });
    expect(prevented).toBe(true);
    expect(rig.sent).toHaveLength(0); // dispatch is via the dep, not a direct emit
  });

  it('Cmd+Z (metaKey) dispatches onUndo', () => {
    rig = setupRig();
    rig.win.fire('keydown', key({ key: 'z', metaKey: true }));
    expect(rig.counts).toEqual({ undo: 1, redo: 0 });
  });

  it('Ctrl+Shift+Z dispatches onRedo', () => {
    rig = setupRig();
    rig.win.fire('keydown', key({ key: 'z', ctrlKey: true, shiftKey: true }));
    expect(rig.counts).toEqual({ undo: 0, redo: 1 });
  });

  it('Ctrl+Y dispatches onRedo', () => {
    rig = setupRig();
    rig.win.fire('keydown', key({ key: 'y', ctrlKey: true }));
    expect(rig.counts).toEqual({ undo: 0, redo: 1 });
  });

  it('a plain z (no modifier) does nothing', () => {
    rig = setupRig();
    rig.win.fire('keydown', key({ key: 'z' }));
    expect(rig.counts).toEqual({ undo: 0, redo: 0 });
  });

  it('a modal open suppresses Ctrl+Z (existing modal guard respected)', () => {
    rig = setupRig();
    rig.modal.open = true;
    rig.win.fire('keydown', key({ key: 'z', ctrlKey: true }));
    expect(rig.counts).toEqual({ undo: 0, redo: 0 });
  });
});

// CR-01: the QuitGuardDialog feeds the SAME isModalOpen gate as the delete guard
// (App wires `guardRef.current !== null || quitGuardOpenRef.current`). This
// asserts the gate the quit guard now participates in actually blocks the
// command-emitting canvas shortcuts (Rotate / Delete), not just Escape/Tab — so
// no GridCommand can fire against the live factory from behind the open dialog.
describe('Modal gate suppresses command-emitting shortcuts (CR-01)', () => {
  it('a selected node + r emits NO Rotate while a modal is open', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    // Select the node first (press-release, no drag), THEN open the modal.
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(2, 2) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(2, 2) });
    expect(rig.selectedId()).toBe(7);

    rig.modal.open = true;
    rig.win.fire('keydown', { key: 'r', shiftKey: false, preventDefault: () => {} });

    // No Rotate command emitted from behind the modal.
    expect(rig.sent).toHaveLength(0);
  });

  it('a selected node + Delete emits nothing and never enters the guard while a modal is open', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(2, 2) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(2, 2) });
    expect(rig.selectedId()).toBe(7);

    rig.modal.open = true;
    rig.win.fire('keydown', { key: 'Delete', preventDefault: () => {} });

    // Neither a direct Delete command nor a deferred in-flight-items guard fires.
    expect(rig.sent).toHaveLength(0);
    expect(rig.deleteWithItems).toHaveLength(0);
  });
});

describe('Selection clear after keyframe (WR-01 / UNDO-06)', () => {
  it('clears a selection whose node is absent from the scene', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(2, 2) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(2, 2) });
    expect(rig.selectedId()).toBe(7);

    // A keyframe re-mints the grid and node 7 is gone (undo of its placement).
    rig.scene.nodes.delete(7);
    rig.clearSel();
    expect(rig.selectedId()).toBeNull();
  });

  it('clears a selection UNCONDITIONALLY even if the handle still exists (WR-01)', () => {
    // The handle survives the keyframe, but a reset may have REUSED it for a
    // different physical node. Clearing must not depend on the id still being
    // present — otherwise a stale selection could retarget a later Delete.
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(2, 2) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(2, 2) });
    expect(rig.selectedId()).toBe(7);

    // Node 7 still present in the scene — clearSelection clears anyway.
    rig.clearSel();
    expect(rig.selectedId()).toBeNull();
  });

  it('no-op when nothing is selected', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    expect(rig.selectedId()).toBeNull();
    rig.clearSel();
    expect(rig.selectedId()).toBeNull();
  });
});

// WR-01: a Rotate echo re-emits the selected node — the selection overlay
// (outline + rotate handle) must be re-derived from the post-apply scene, not
// stay pinned to the box drawn at select time.
describe('Selection refresh on echo (WR-01)', () => {
  const selectNode = (r: Rig): void => {
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...at(2, 2) });
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...at(2, 2) });
  };

  it('re-derives the selection overlay when the SELECTED node is re-emitted', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    selectNode(rig);
    expect(rig.overlay.selections).toEqual([7]);

    // A Rotate echo lands: node 7 is re-emitted (rot changed host-side).
    rig.refreshSel([7]);
    expect(rig.overlay.selections).toEqual([7, 7]); // showSelection re-invoked
    expect(rig.sent).toHaveLength(0); // display-only refresh, no command
  });

  it('a re-emit of a DIFFERENT node leaves the selection overlay untouched', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    selectNode(rig);
    rig.refreshSel([9]);
    expect(rig.overlay.selections).toEqual([7]); // no extra redraw
  });

  it('no-op when nothing is selected', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    rig.refreshSel([7]);
    expect(rig.overlay.selections).toEqual([]);
  });
});

describe('Rotate ghost preview (placement armed, CTRL-03 / D-14)', () => {
  const rKey = (shift: boolean) => ({
    key: shift ? 'R' : 'r',
    shiftKey: shift,
    preventDefault: () => {},
  });

  it('arming a ROUTER draws the 2x3 footprint; r cycles rot 1,2,3 and re-renders; Shift+R steps back', () => {
    rig = setupRig();
    rig.begin(machine_kind.ROUTER);
    // Move onto the canvas floor → ghost snaps and sizes to the 2x3 footprint.
    rig.win.fire('pointermove', { target: rig.canvas, clientX: 5.5, clientY: 5.5 });
    expect(rig.overlay.ghostCalls.at(-1)?.dims).toEqual({ w: 2, h: 3, rot: 0 });

    // 'r' x3: each press cycles the ghost rot CW and re-renders at the last
    // pointer position — no command is emitted (rotation lands post-echo).
    const rots: number[] = [];
    for (let i = 0; i < 3; i++) {
      rig.win.fire('keydown', rKey(false));
      rots.push(rig.overlay.ghostCalls.at(-1)!.dims!.rot);
      if (i === 0) {
        // The re-render carries the ROTATED catalog port preview (rot-1 closed form
        // for the 74.1-14 ROUTER: In (0,1)W -> (1,0)N, then the three Outs
        // (1,1)E -> (1,1)S, (1,2)E -> (0,1)S and (1,0)E -> (2,1)S, and since PILE-10
        // the Fault nub (0,2)S -> (0,0)W).
        expect(rig.overlay.ghostCalls.at(-1)?.ports).toEqual([
          { lx: 1, ly: 0, side: 0, role: 0, medium: 0 },
          { lx: 1, ly: 1, side: 2, role: 1, medium: 0 },
          { lx: 0, ly: 1, side: 2, role: 1, medium: 0 },
          { lx: 2, ly: 1, side: 2, role: 1, medium: 0 },
          { lx: 0, ly: 0, side: 3, role: 2, medium: 0 },
        ]);
      }
    }
    expect(rots).toEqual([1, 2, 3]);
    expect(rig.sent).toHaveLength(0);

    // Shift+R from 3 → 2 (CCW arithmetic: (3 + 3) & 3).
    rig.win.fire('keydown', rKey(true));
    expect(rig.overlay.ghostCalls.at(-1)?.dims).toEqual({ w: 2, h: 3, rot: 2 });
    expect(rig.sent).toHaveLength(0);
  });
});

// The armed footprint must SURVIVE the cursor travelling over the palette.
//
// The defect: the off-canvas branch of onWinMove called `ghost.clear()`, which
// hid the ghost AND destroyed the arm (`placement`/`placementPorts` nulled).
// Arming from the palette leaves the cursor OVER the palette, so the very next
// pointermove disarmed the footprint, and nothing re-set it on canvas re-entry.
// The ghost then degraded to the `{w:1,h:1}` fallback: it occupancy-checked ONE
// cell instead of six and drew a solid 1x1, so it painted VALID-blue over ground
// where the real 2x3 body collides — an invitation the host then refuses.
//
// NOTE ON NON-VACUITY: every shipped e2e was green over this because
// `page.mouse.move` defaults to `steps: 1` — a single jump that lands on the
// canvas and never emits an intermediate move over the palette. These units fire
// that intermediate move explicitly (a pointermove whose target is NOT the
// canvas), which is the only input shape that reaches the broken path. They were
// watched failing on the unfixed controller before the hide()/clear() split.
describe('armed footprint survives an off-canvas pointermove (palette hover)', () => {
  /** A non-canvas event target — the palette the cursor is still sitting on. */
  const palette = {} as unknown;

  /** A 2x3 ROUTER at (2,2): body cells (2,2),(3,2),(2,3),(3,3),(2,4),(3,4). */
  const occupant = () =>
    node({
      id: 42,
      kind: machine_kind.ROUTER,
      cell_x: 2,
      cell_y: 2,
      w: 2,
      h: 3,
    });

  it('keeps the FULL 2x3 footprint after the cursor passes over the palette', () => {
    rig = setupRig(occupant());
    rig.begin(machine_kind.ROUTER);

    // The move a real hand always emits: still over the palette, off the canvas.
    rig.win.fire('pointermove', { target: palette, ...at(5, 5) });

    // Re-enter the canvas at (1,1). Its ANCHOR cell is free, but the 2x3 box
    // spans x 1..2, y 1..3 and so covers the occupant's (2,2) and (2,3).
    rig.win.fire('pointermove', { target: rig.canvas, ...at(1, 1) });

    const drawn = rig.overlay.ghostCalls.at(-1);
    // Both halves of the defect in one diff:
    //   valid must be false — the verdict is computed over all SIX cells, so
    //     the ghost warns in red instead of inviting in blue;
    //   dims must be the real footprint — undefined dims make the overlay take
    //     its {ew:1, eh:1} branch and paint a solid build-blue 1x1.
    expect({ valid: drawn?.valid, dims: drawn?.dims }).toEqual({
      valid: false,
      dims: { w: 2, h: 3, rot: 0 },
    });
    // The rotated catalog port preview survives too (placementPorts intact).
    expect(drawn?.ports).toEqual([
      // The 74.1-14 Router catalog (In on the middle row, Outs on rows 1, 2, 0).
      { lx: 0, ly: 1, side: 3, role: 0, medium: 0 },
      { lx: 1, ly: 1, side: 1, role: 1, medium: 0 },
      { lx: 1, ly: 2, side: 1, role: 1, medium: 0 },
      { lx: 1, ly: 0, side: 1, role: 1, medium: 0 },
      // PILE-10 (phase 71): the Router's spatial Role::Fault nub, S@(0,2), APPENDED so
      // it sorts last and shifts no existing index. The ghost previews a nub per catalog
      // row, so without this row the fault port would be invisible while armed.
      { lx: 0, ly: 2, side: 2, role: 2, medium: 0 },
    ]);
  });

  it('keeps a ROTATED footprint across the same palette hover', () => {
    rig = setupRig(occupant());
    rig.begin(machine_kind.ROUTER);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(9, 9) });
    rig.win.fire('keydown', { key: 'r', shiftKey: false, preventDefault: () => {} });

    rig.win.fire('pointermove', { target: palette, ...at(5, 5) });
    // rot 1 anchors a 3-wide, 2-tall box: at (0,2) it spans x 0..2, y 2..3 and
    // hits the occupant at (2,2). The UNROTATED box at (0,2) spans x 0..1 only,
    // so a lost rot — not just a lost size — would flip this verdict too.
    rig.win.fire('pointermove', { target: rig.canvas, ...at(0, 2) });

    const drawn = rig.overlay.ghostCalls.at(-1);
    expect({ valid: drawn?.valid, dims: drawn?.dims }).toEqual({
      valid: false,
      dims: { w: 2, h: 3, rot: 1 },
    });
  });

  it('still HIDES the ghost while the cursor is off the canvas', () => {
    // The other half of the split: hiding is what the off-canvas branch is for.
    // Without this, "fixing" the bug by deleting the else branch would pass.
    rig = setupRig(occupant());
    rig.begin(machine_kind.ROUTER);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(9, 9) });
    const clearedBefore = rig.overlay.ghostCleared.count;

    rig.win.fire('pointermove', { target: palette, ...at(5, 5) });

    expect(rig.overlay.ghostCleared.count).toBeGreaterThan(clearedBefore);
  });

  it('a palette hover between arm and click does not stop the Place committing', () => {
    rig = setupRig(occupant());
    rig.begin(machine_kind.ROUTER);
    rig.win.fire('pointermove', { target: palette, ...at(5, 5) });
    // (10,10): all six cells clear of the occupant at (2,2).
    rig.win.fire('pointermove', { target: rig.canvas, ...at(10, 10) });
    expect(rig.overlay.ghostCalls.at(-1)?.valid).toBe(true);

    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(10, 10) });
    expect(rig.sent).toHaveLength(1);
    expect(rig.sent[0][0]).toBe(0); // Place discriminant
  });
});

// WR-08: cancel paths for an armed placement. A non-left release is a cancel
// (right-click is the universal cancel gesture, mirroring the Belt tool), and
// Escape disarms the placement outright — neither may emit a logged Place.
describe('Placement cancel paths (WR-08)', () => {
  it('a right-button press on the canvas while armed is a decisive cancel: no Place, ghost cleared, pan restored', () => {
    rig = setupRig();
    rig.begin(machine_kind.SOURCE);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(5, 5) });
    const clearedBefore = rig.overlay.ghostCleared.count;

    // IX-08/Pitfall-2: right-click cancels on POINTERDOWN (mirroring the Belt
    // tool), so the OS context menu that fires after the click can never open
    // over a still-armed tool.
    rig.canvas.fire('pointerdown', { button: 2, target: rig.canvas, ...at(5, 5) });

    expect(rig.sent).toHaveLength(0); // NOT a logged Place
    expect(rig.overlay.ghostCleared.count).toBeGreaterThan(clearedBefore);
    expect(rig.panState.enabled).toBe(true);
    expect(rig.cursor()).toBe(''); // crosshair released
    expect(rig.armedCalls.at(-1)).toBeNull(); // onArmedChange(null)

    // The placement is disarmed: a later left release emits nothing either.
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(5, 5) });
    expect(rig.sent).toHaveLength(0);
  });

  it('a_middle_press_with_a_machine_tool_armed_keeps_the_tool', () => {
    // D-11 and NAV-04 for the machine tools (plan 89-10, seen on the real-app walk): the middle
    // button pans the camera whatever is armed and never cancels. Until plan 89-10 a middle press
    // with a machine armed fell in IX-08's "any non-left press" and put the tool away, so a user
    // who panned while placing lost the tool. Only the right button cancels (the case above).
    rig = setupRig();
    rig.begin(machine_kind.SOURCE);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(5, 5) });
    const armed = rig.armedCalls.at(-1);
    expect(armed, 'NON-VACUITY: the tool is armed before the middle press').not.toBeNull();
    const clearedBefore = rig.overlay.ghostCleared.count;
    rig.canvas.fire('pointerdown', { button: 1, target: rig.canvas, ...at(5, 5) });
    rig.win.fire('pointermove', { button: -1, buttons: 4, target: rig.canvas, ...at(6, 6) });
    rig.win.fire('pointerup', { button: 1, target: rig.canvas, ...at(6, 6) });
    expect(rig.sent, 'a middle press and release places nothing').toHaveLength(0);
    expect(rig.armedCalls.at(-1), 'the machine tool is still armed').toEqual(armed);
    expect(rig.overlay.ghostCleared.count, 'the ghost was not cleared').toBe(clearedBefore);
    expect(rig.cursor(), 'the crosshair stays').toBe('crosshair');
    // The tool still places on the next left press and release.
    rig.win.fire('pointermove', { target: rig.canvas, ...at(5, 5) });
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(5, 5) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(5, 5) });
    expect(rig.sent).toHaveLength(1);
    expect(rig.sent[0][0]).toBe(0); // Place discriminant
  });

  it('Escape cancels an armed placement: ghost cleared, pan restored, later release emits nothing', () => {
    rig = setupRig();
    rig.begin(machine_kind.SOURCE);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(5, 5) });
    expect(rig.panState.enabled).toBe(false);
    const clearedBefore = rig.overlay.ghostCleared.count;

    rig.win.fire('keydown', { key: 'Escape', preventDefault: () => {} });

    expect(rig.overlay.ghostCleared.count).toBeGreaterThan(clearedBefore);
    expect(rig.panState.enabled).toBe(true);
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(5, 5) });
    expect(rig.sent).toHaveLength(0);
  });

  it('a left release still commits exactly one Place (regression)', () => {
    rig = setupRig();
    rig.begin(machine_kind.SOURCE);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(5, 5) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(5, 5) });
    expect(rig.sent).toHaveLength(1);
    expect(rig.sent[0][0]).toBe(0); // Place discriminant
  });
});

// CTRL-03: the Place-then-N-Rotate commit sequence. Place goes out alone (the
// schema carries no rot); the N Rotates ride the Place's accept and the packet that
// shows the handle it names (phase 88, D-06): the test emits, delivers the accept,
// INJECTS the echoed node, then flushes the manual rAF queue (Finding 4: a same-tick
// batch can never reference a same-batch mint).
describe('Place-then-N-Rotate commit sequence (CTRL-03)', () => {
  const rKey = { key: 'r', shiftKey: false, preventDefault: () => {} };

  /** Arm a ROUTER, hover cell (5,5), press 'r' `rot` times, release to commit. */
  const commitRotated = (r: Rig, rot: number): void => {
    r.begin(machine_kind.ROUTER);
    r.win.fire('pointermove', { target: r.canvas, ...at(5, 5) });
    for (let i = 0; i < rot; i++) {
      r.win.fire('keydown', rKey);
    }
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...at(5, 5) });
  };

  /** The echoed ROUTER node under a fresh handle at the committed cell. */
  const echoedRouter = (id: number): NodeView =>
    node({
      id,
      kind: machine_kind.ROUTER,
      cell_x: 5,
      cell_y: 5,
      w: 2,
      h: 3,
    });

  it('placementRot=2: exactly one Place, then exactly two ccw:false Rotates after the echo (byte-equal, ordered)', () => {
    rig = setupRig();
    commitRotated(rig, 2);

    // Release emits ONLY the Place (no rot field on the wire; no synchronous
    // Rotate — the node handle does not exist yet).
    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({
        kind: 'Place',
        kind_byte: machine_kind.ROUTER,
        cell_x: 5,
        cell_y: 5,
      }),
    ]);

    // The host accepts the Place, naming handle 42, and the packet shows it: the watcher
    // drains the queue at the handle the accept named.
    rig.accept(1, [42]);
    rig.scene.nodes.set(42, echoedRouter(42));
    rig.flushRaf();

    // Exactly two more frames — both Rotate{node:42, ccw:false}, back-to-back.
    expect(rig.sent).toHaveLength(3);
    expect(rig.sentOpts.slice(1), "both name the accept's generation").toEqual([{ generation: 0 }, { generation: 0 }]);
    const rotateFrame = [
      ...encodeGridCommand({ kind: 'Rotate', node: 42, ccw: false }),
    ];
    expect([...rig.sent[1]]).toEqual(rotateFrame);
    expect([...rig.sent[2]]).toEqual(rotateFrame);

    // The queue drained: further flushes emit nothing.
    rig.flushRaf();
    expect(rig.sent).toHaveLength(3);
  });

  it('placementRot=0: Place only, zero Rotates after the echo', () => {
    rig = setupRig();
    commitRotated(rig, 0);
    expect(rig.sent).toHaveLength(1);

    rig.accept(1, [42]);
    rig.scene.nodes.set(42, echoedRouter(42));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent).toHaveLength(1); // no follow-up frames
  });

  it('a keyframe between Place and accept keeps the rotate queue, addressed by the accept (phase 88, D-06; was T-21-16)', () => {
    rig = setupRig();
    commitRotated(rig, 2);
    expect(rig.sent).toHaveLength(1);

    // A full:true keyframe lands BEFORE the answer. Until phase 88 the queued Rotates died
    // here, because the client found its node by the cell and a reminted handle could name
    // another node. The accept now names the handle and its generation, so the queue
    // survives and goes out addressed to exactly that.
    rig.clearSel();
    rig.scene.generation = 1;
    rig.accept(1, [42], 1);
    rig.scene.nodes.set(42, echoedRouter(42));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent.slice(1).map((b) => [...b])).toEqual([
      [...encodeGridCommand({ kind: 'Rotate', node: 42, ccw: false })],
      [...encodeGridCommand({ kind: 'Rotate', node: 42, ccw: false })],
    ]);
    expect(rig.sentOpts.slice(1)).toEqual([{ generation: 1 }, { generation: 1 }]);
  });

  it('a later keyframe that no longer shows the placed machine sends none of its follow-ups (phase 88 review, IN-02)', () => {
    // A turned Router dropped, then Ctrl+Z before its packet drew: the Place is accepted at
    // generation 0 as handle 42, and the Undo's keyframe (generation 1) is the first the page
    // sees. That board holds no Router at (5,5), so the Undo took the Place itself back. The
    // queued Rotate would be refused UnknownNode and the band would read "That is no longer on
    // the board." about a turn the user never sent; it is dropped instead, in silence.
    rig = setupRig();
    commitRotated(rig, 1);
    rig.accept(1, [42]);
    rig.clearSel();
    rig.scene.generation = 1;
    rig.scene.nodes.clear();
    const clearedBefore = rig.overlay.pendingCleared.count;
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent, 'the Place only: no Rotate for a machine the board no longer has').toHaveLength(1);
    expect(rig.overlay.pendingCleared.count, 'the entry ended and its shimmer cleared').toBeGreaterThan(clearedBefore);
  });

  it("after Undo then Redo re-mints the placed Router, its queued Rotate goes to the accept's own handle, sent quiet (phase 88, T-88-25 re-audit)", () => {
    // A turned Router dropped at (5,5): the Place is accepted at generation 0 as handle 42.
    // The user presses Ctrl+Z (generation 1) and Ctrl+Shift+Z (generation 2) before any packet
    // showed 42, and the Redo's keyframe is the first the page sees. Redo restores the Router
    // with a NEW node id, so table 0's handle 42 names a node that is gone and the host refuses
    // the Rotate UnknownNode. The client cannot tell that Router from another one placed on the
    // same anchor (the re-audit's case below), so it never names a machine again by kind and
    // anchor: the Rotate goes to the accept's own (0, 42), which only the host can resolve, and
    // it is sent QUIET, so its refusal shows no sentence about a turn the user never sent.
    // NAMED CHANGED OUTCOME: until the re-audit it went to 17 in table 2.
    rig = setupRig();
    commitRotated(rig, 1);
    rig.accept(1, [42]);
    rig.clearSel();
    rig.clearSel();
    rig.scene.generation = 2;
    rig.scene.nodes.clear();
    rig.scene.nodes.set(17, echoedRouter(17));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent.slice(1).map((b) => [...b]), "one Rotate, for the accept's own handle").toEqual([
      [...encodeGridCommand({ kind: 'Rotate', node: 42, ccw: false })],
    ]);
    expect(rig.sentOpts[1], "addressed in the accept's table, and quiet").toEqual({ generation: 0, quiet: true });
    expect(rig.waiting().placements, 'and the entry ended').toBe(0);
  });

  it('after an Undo and a fresh unturned Place of the same kind on the same anchor, the first Place\'s Rotates never reach the second machine (phase 88, T-88-25 re-audit)', () => {
    // The re-audit's case. Router A is placed turned twice at (5,5) and accepted as (0, 42).
    // Ctrl+Z (generation 1) takes A away, and Router B is dropped UNTURNED on (5,5), accepted
    // as (1, 17). The Undo's keyframe, showing only B, reaches the page before A's packet.
    // Naming a machine again by kind and anchor found B and sent it A's two turns, live in the
    // newest table: B ended up turned though the user placed it unturned. A's Rotates must go
    // to A's own (0, 42), where the host refuses them (A is gone), quiet.
    rig = setupRig();
    commitRotated(rig, 2);
    const afterA = rig.sent.length;
    // The tool stays armed (IX-06). Two more CW turns bring the ghost back to 0; drop B.
    for (let i = 0; i < 2; i++) rig.win.fire('keydown', rKey);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(5, 5) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(5, 5) });
    expect(rig.sent.length, 'non-vacuity: B was sent as its own Place').toBe(afterA + 1);
    const placesSent = rig.sent.length;
    rig.accept(1, [42], 0);
    rig.accept(2, [17], 1);
    rig.scene.generation = 1;
    rig.scene.nodes.clear();
    rig.scene.nodes.set(17, echoedRouter(17));
    rig.clearSel();
    rig.flushRaf();
    rig.flushRaf();
    const rotate = (node: number) => [...encodeGridCommand({ kind: 'Rotate', node, ccw: false })];
    expect(rig.sent.slice(placesSent).map((b) => [...b]), "A's two turns, to A's own handle; none to B").toEqual([
      rotate(42),
      rotate(42),
    ]);
    expect(rig.sentOpts.slice(placesSent), "in A's table, quiet").toEqual([
      { generation: 0, quiet: true },
      { generation: 0, quiet: true },
    ]);
    expect(rig.waiting().placements, 'both entries ended').toBe(0);
  });

  it('a swap keyframe before an accepted Place lands sends none of its follow-ups, though the loaded board has the same machine there (phase 88, T-88-25, T-88-11)', () => {
    // Accepted at generation 0 as handle 42, then a Load's keyframe (generation 1, the host's
    // new swap floor) is the first the page sees, and the loaded board happens to hold a
    // Router on (5,5). Naming it again there would turn a machine of the loaded board; the
    // swap ends the entry with nothing sent.
    rig = setupRig();
    commitRotated(rig, 1);
    rig.accept(1, [42]);
    expect(rig.waiting().placements, 'non-vacuity: the Place waits with a Rotate owed').toBe(1);
    rig.scene.generation = 1;
    rig.scene.nodes.clear();
    rig.scene.nodes.set(9, echoedRouter(9));
    rig.swap();
    rig.clearSel();
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent, 'the Place only: no Rotate onto the loaded board').toHaveLength(1);
    expect(rig.waiting().placements, 'and the entry ended').toBe(0);
  });

  it('a Load this page did not ask for (another page, a claim used up early) still ends an accepted Place with nothing sent: the packet names the swap floor (phase 88, T-88-11 re-audit)', () => {
    // The case above with no `onSwap`: App calls it only when this page asked for the swap, so
    // a Load from a second dev-WebSocket client, or a swap whose claim an earlier Undo keyframe
    // used up, never reaches it. The keyframe itself says a swap happened: its swap floor is
    // its own generation, above the accept's.
    rig = setupRig();
    commitRotated(rig, 1);
    rig.accept(1, [42]);
    expect(rig.waiting().placements, 'non-vacuity: the Place waits with a Rotate owed').toBe(1);
    rig.scene.generation = 1;
    rig.scene.swapFloor = 1;
    rig.scene.nodes.clear();
    rig.scene.nodes.set(9, echoedRouter(9));
    rig.clearSel();
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent, 'the Place only: no Rotate onto the loaded board').toHaveLength(1);
    expect(rig.waiting().placements, 'and the entry ended').toBe(0);
  });

  it("a keyframe of a later generation lands an accepted Place at once, addressed to the accept's own handle and sent quiet (phase 88, T-88-25 re-audit; research Pitfall 3; was WR-03 / IX-05)", () => {
    rig = setupRig();
    commitRotated(rig, 1);
    expect(rig.sent).toHaveLength(1); // the Place
    // Accepted at generation 0 as handle 42, and an Undo's keyframe (generation 1) arrives
    // before any packet showed 42. The Rotate goes out addressed (0, 42), the accept's own
    // table, so the host resolves the machine the Place minted. It is sent QUIET: past the
    // accept's table the client cannot know that node still lives, and a refusal of a turn the
    // user made on the ghost must not read as a fresh failure (T-88-25 re-audit; before
    // then it went to the Router on this anchor in the newest table, (1, 42)).
    rig.accept(1, [42]);
    rig.clearSel();
    rig.scene.generation = 1;
    rig.scene.nodes.set(42, echoedRouter(42));
    const clearedBefore = rig.overlay.pendingCleared.count;
    rig.flushRaf();
    expect(rig.sent.slice(1).map((b) => [...b])).toEqual([
      [...encodeGridCommand({ kind: 'Rotate', node: 42, ccw: false })],
    ]);
    expect(rig.sentOpts[1]).toEqual({ generation: 0, quiet: true });
    expect(rig.overlay.pendingCleared.count, 'the entry ended and its shimmer cleared').toBeGreaterThan(clearedBefore);
    rig.flushRaf();
    expect(rig.sent).toHaveLength(2);
  });

  it('a keyframe before the verdict keeps the shimmer; the refusal ends it (phase 88, D-10; was WR-03 / IX-05)', () => {
    rig = setupRig();
    commitRotated(rig, 1);
    const clearedBefore = rig.overlay.pendingCleared.count;
    rig.clearSel();
    expect(rig.overlay.pendingCleared.count, 'a keyframe is not the answer').toBe(clearedBefore);
    rig.refuse(1, 'FootprintCollision');
    expect(rig.overlay.pendingCleared.count, 'the refusal is').toBeGreaterThan(clearedBefore);
    rig.scene.nodes.set(42, echoedRouter(42));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent).toHaveLength(1); // still just the Place
  });

  it('the echo watch expires after the tick TTL with no echo (WR-03 / IX-05 unechoed Place)', () => {
    rig = setupRig();
    commitRotated(rig, 1);
    expect(rig.sent).toHaveLength(1);
    const clearedBefore = rig.overlay.pendingCleared.count;

    // The host refused the Place (occupancy race): no echo ever lands. Since
    // Phase 64 the host's typed verdict tells the USER why, and this TTL is
    // still the thing that stops the LOOP — the two answer different questions.
    // A verdict says "refused"; the echo says "the machine appeared", and only
    // the second can clear a pending affordance. Once the sim advances past
    // ECHO_TTL_TICKS (120) the watcher abandons: the neutral pending shimmer
    // clears (no false-success blue vanish), the rotate queue drops, the loop
    // ends.
    rig.scene.tick = 121;
    rig.flushRaf();
    expect(rig.overlay.pendingCleared.count).toBeGreaterThan(clearedBefore);

    // Fully abandoned: a node landing at the cell afterwards triggers nothing.
    rig.scene.nodes.set(42, echoedRouter(42));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent).toHaveLength(1);
  });
});

// ROUTE-06 (36-05): a Router PRESET placement. Placing emits Place{ROUTER} alone
// (the handle does not exist yet); once the host echoes the bare router, the
// port-seeding sequence rides the SAME echo watcher - the EXACT command shape
// GridSession::place_router_preset runs (plan 36-03): RemovePort the bare catalog
// ports (highest index first), then AddPort the preset legs: the In and Outs AT
// `medium`, the Fault at MECHANICAL for both presets (plan 85-05, D-22).
//
// Both halves of the expected sequence are DERIVED from the catalog here, exactly as
// the shipped code derives them (plan 65-05). Until 65-05 the bare fixture below
// declared a TWO-port Router, four months after the catalog widened to four, so this
// suite asserted a command sequence the application never emitted: green, and blind to
// the thing it guarded.
describe('Router preset placement seeds typed ports on echo (ROUTE-06)', () => {
  /** The real bare catalog ports for a ROUTER anchored at (5,5), from the catalog. */
  const bareRouterPorts = () =>
    catalogEntry(machine_kind.ROUTER).ports.map((p) => ({
      index: p.index,
      cell_x: 5 + p.local_x,
      cell_y: 5 + p.local_y,
      side: p.side,
      role: p.role,
      medium: 0,
    }));

  /** The BARE echoed router, carrying the catalog port set (all Mechanical). */
  const bareRouter = (id: number): NodeView =>
    node({
      id,
      kind: machine_kind.ROUTER,
      cell_x: 5,
      cell_y: 5,
      w: 2,
      h: 3,
      ports: bareRouterPorts(),
    });

  /** Arm a preset at `medium`, drop at (5,5), accept it as 42, echo the bare router, drain rAF. */
  const placePreset = (r: Rig, medium: number): void => {
    r.beginRouterPreset(medium);
    r.win.fire('pointermove', { target: r.canvas, ...at(5, 5) });
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...at(5, 5) });
    r.accept(r.sent.length, [42]);
    r.scene.nodes.set(42, bareRouter(42));
    r.flushRaf();
  };

  /** The seeding sequence the host runs for a preset at `medium` on node 42. */
  const seedFrames = (medium: number): number[][] => [
    // One RemovePort per port the echoed node actually declares, highest index first.
    ...bareRouterPorts()
      .map((p) => p.index)
      .sort((a, b) => b - a)
      .map((index) => [...encodeGridCommand({ kind: 'RemovePort', node: 42, index })]),
    // One AddPort per catalog port, in catalog order with the In first. The Fault leg
    // is Mechanical whatever the preset medium (85-05, D-22): role 2 is the Fault.
    ...catalogEntry(machine_kind.ROUTER).ports.map((p) => [
      ...encodeGridCommand({
        kind: 'AddPort',
        node: 42,
        role: p.role,
        side: p.side,
        medium: p.role === 2 ? MEDIUM_MECHANICAL : medium,
      }),
    ]),
    // 73-06: ...and the preset DECLARES ITS OWN FALLBACK as its last frame. The
    // RemovePort loop above strips the very Out the bare Router's minted `default`
    // named, and since UNDO-04 `fold_remove_port` clears a `default` naming a
    // removed key rather than letting it silently come to mean a different physical
    // output. So the preset owes a value it used to inherit by accident: routing key
    // 0, the first Out the seed loop planted, which is the SAME observable answer
    // the app already gave. Its twin is `GridSession::place_router_preset`.
    [...encodeGridCommand({ kind: 'Configure', node: 42, config: { kind: 'Router', routes: [], default: 0 } })],
  ];

  /**
   * Place + strip + seed: one Place, one frame per strip and per seed leg, and the
   * ONE trailing Configure that declares the preset's fallback (73-06).
   */
  const totalFrames = (): number => 2 + 2 * catalogEntry(machine_kind.ROUTER).ports.length;

  it('HTTP Router (Electrical): Place{ROUTER} alone, then strip + seed the catalog profile at Electrical', () => {
    const rig = setupRig();
    rig.beginRouterPreset(MEDIUM_ELECTRICAL);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(5, 5) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(5, 5) });

    // Release emits ONLY the Place (the router handle does not exist yet).
    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({ kind: 'Place', kind_byte: machine_kind.ROUTER, cell_x: 5, cell_y: 5 }),
    ]);

    // Accept naming 42, echo the bare router: the watcher drains the strip + seed at
    // Electrical, every frame addressed with the accept's generation.
    rig.accept(1, [42]);
    rig.scene.nodes.set(42, bareRouter(42));
    rig.flushRaf();
    expect(rig.sent.slice(1).map((b) => [...b])).toEqual(seedFrames(MEDIUM_ELECTRICAL));
    expect(rig.sentOpts.slice(1).every((o) => o?.generation === 0)).toBe(true);

    // Drained: further flushes emit nothing.
    rig.flushRaf();
    expect(rig.sent).toHaveLength(totalFrames());
    rig.destroy();
  });

  it('Router preset (Mechanical): same command SHAPE, only the seeded medium differs', () => {
    const rig = setupRig();
    placePreset(rig, MEDIUM_MECHANICAL);
    expect(rig.sent.slice(1).map((b) => [...b])).toEqual(seedFrames(MEDIUM_MECHANICAL));
    rig.destroy();
  });

  it('both presets send five AddPorts with the Fault at Mechanical (D-22, GATE-06)', () => {
    // Read off the shipped producer itself, not off `seedFrames` above (which restates
    // the rule): five legs, one of them the Fault, and that one Mechanical for BOTH the
    // HTTP and the Item preset; every other leg at the preset medium.
    for (const medium of [MEDIUM_ELECTRICAL, MEDIUM_MECHANICAL]) {
      const adds = routerPresetSeedCommands(bareRouter(42), medium).filter(
        (c): c is Extract<typeof c, { kind: 'AddPort' }> => c.kind === 'AddPort',
      );
      expect(adds, `medium ${medium}: five AddPort legs, the whole catalog row`).toHaveLength(5);
      const faults = adds.filter((c) => c.role === 2);
      expect(faults, `medium ${medium}: exactly one Fault leg`).toHaveLength(1);
      expect(faults[0].medium, `medium ${medium}: the Fault leg is Mechanical`).toBe(MEDIUM_MECHANICAL);
      expect(
        adds.filter((c) => c.role !== 2).every((c) => c.medium === medium),
        `medium ${medium}: every In and Out leg carries the preset medium`,
      ).toBe(true);
    }
  });

  it("after Undo then Redo re-mints a preset Router, its seeding goes to the accept's own handle, sent quiet (phase 88, T-88-25 re-audit)", () => {
    // An HTTP Router preset accepted at generation 0 as handle 42; the Redo's keyframe
    // (generation 2) comes first and shows the restored bare Router as 17. The seeding is
    // read off the Router on that anchor (its ports are a bare Router's either way) and sent
    // to (0, 42), quiet: the host seeds the Router the Place minted while it lives, and refuses
    // in silence once Undo then Redo re-minted it. NAMED CHANGED OUTCOME: until
    // the re-audit it went to 17 in table 2, which could seed a different Router (see the
    // Rotate case above).
    const rig = setupRig();
    rig.beginRouterPreset(MEDIUM_ELECTRICAL);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(5, 5) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(5, 5) });
    rig.accept(1, [42]);
    rig.clearSel();
    rig.clearSel();
    rig.scene.generation = 2;
    rig.scene.nodes.clear();
    rig.scene.nodes.set(17, bareRouter(17));
    rig.flushRaf();
    expect(rig.sent.slice(1).map((b) => [...b]), "the whole seeding, on the accept's handle 42").toEqual(
      routerPresetSeedCommands({ ...bareRouter(17), id: 42 }, MEDIUM_ELECTRICAL).map((c) => [...encodeGridCommand(c)]),
    );
    expect(rig.sent).toHaveLength(totalFrames());
    expect(
      rig.sentOpts.slice(1).every((o) => o?.generation === 0 && o.quiet === true),
      "every frame in the accept's table, quiet",
    ).toBe(true);
    rig.destroy();
  });

  it('a plain (non-preset) ROUTER placement seeds NOTHING on echo (regression)', () => {
    const rig = setupRig();
    rig.begin(machine_kind.ROUTER);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(5, 5) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(5, 5) });
    rig.accept(1, [42]);
    rig.scene.nodes.set(42, bareRouter(42));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent).toHaveLength(1); // just the Place, no port seeding
    rig.destroy();
  });
});

// WR-A: a rapid rotated repeat-placement burst. The tool stays armed (IX-06)
// and placementRot persists, so placing at A then B BEFORE A echoes must NOT
// drop A's queued Rotates. Each cell's Rotates are tracked per-cell and emit
// against that cell's OWN minted handle once it echoes — the old single-slot
// design let the second Place clobber the first cell's queue, silently
// committing the earlier machine at rot 0.
describe('Rapid rotated repeat-placement keeps every cell Rotates (WR-A)', () => {
  const rKey = { key: 'r', shiftKey: false, preventDefault: () => {} };

  const router = (id: number, cx: number, cy: number): NodeView =>
    node({ id, kind: machine_kind.ROUTER, cell_x: cx, cell_y: cy, w: 2, h: 3 });

  const placeFrame = (cx: number, cy: number): number[] => [
    ...encodeGridCommand({
      kind: 'Place',
      kind_byte: machine_kind.ROUTER,
      cell_x: cx,
      cell_y: cy,
    }),
  ];
  const rotFrame = (nodeId: number): number[] => [
    ...encodeGridCommand({ kind: 'Rotate', node: nodeId, ccw: false }),
  ];

  it('places A then B before A echoes; both get their 2 Rotates targeted by handle', () => {
    rig = setupRig();

    // Arm a ROUTER, press 'r' twice (placementRot=2), commit at A(5,5).
    rig.begin(machine_kind.ROUTER);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(5, 5) });
    rig.win.fire('keydown', rKey);
    rig.win.fire('keydown', rKey);
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(5, 5) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(5, 5) });

    // IMMEDIATELY commit at B(9,9) before A echoes — the tool stayed armed and
    // placementRot persists (IX-06), so B also intends rot 2. No new 'r' press.
    rig.win.fire('pointermove', { target: rig.canvas, ...at(9, 9) });
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(9, 9) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(9, 9) });

    // Two Places emitted, zero synchronous Rotates (the handles do not exist yet).
    expect(rig.sent).toHaveLength(2);
    expect([...rig.sent[0]]).toEqual(placeFrame(5, 5));
    expect([...rig.sent[1]]).toEqual(placeFrame(9, 9));

    // Both are accepted under DISTINCT handles and both echo; the shared watcher drains
    // each at its own accept's handle.
    rig.accept(1, [42]);
    rig.accept(2, [43]);
    rig.scene.nodes.set(42, router(42, 5, 5));
    rig.scene.nodes.set(43, router(43, 9, 9));
    rig.flushRaf();

    // 2 Places + 4 Rotates: A's two target handle 42, B's two target handle 43
    // (in push order A then B). The earlier cell's Rotates were NOT dropped.
    expect(rig.sent).toHaveLength(6);
    expect([...rig.sent[2]]).toEqual(rotFrame(42));
    expect([...rig.sent[3]]).toEqual(rotFrame(42));
    expect([...rig.sent[4]]).toEqual(rotFrame(43));
    expect([...rig.sent[5]]).toEqual(rotFrame(43));

    // Both queues drained: further flushes emit nothing.
    rig.flushRaf();
    expect(rig.sent).toHaveLength(6);
  });
});

// CTRL-03 / D-13: the on-canvas rotate handle. The overlay owns the center
// (configurable in the rig); gestures hit-test it within the 12px radius —
// down+up inside emits exactly one Rotate (Shift = CCW); up outside cancels.
describe('Rotate-handle click (CTRL-03 / D-13)', () => {
  /** Raw client-px event coords (screen px == world px under the identity cam). */
  const atPx = (x: number, y: number) => ({ clientX: x, clientY: y });

  /** Select node 7 at (2,2), then park the rotate handle at a known point. */
  const selectWithHandle = (r: Rig, pt: Pt): void => {
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...at(2, 2) });
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...at(2, 2) });
    expect(r.selectedId()).toBe(7);
    r.overlay.rotateCenter.pt = pt;
  };

  const handlePt: Pt = { x: 200, y: 90 };

  it('down+up within 12px of the handle emits exactly one Rotate ccw:false (byte-equal to the keyboard frame)', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    selectWithHandle(rig, handlePt);

    rig.canvas.fire('pointerdown', {
      button: 0,
      target: rig.canvas,
      ...atPx(handlePt.x + 5, handlePt.y),
    });
    rig.win.fire('pointerup', {
      button: 0,
      shiftKey: false,
      target: rig.canvas,
      ...atPx(handlePt.x + 5, handlePt.y),
    });

    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({ kind: 'Rotate', node: 7, ccw: false }),
    ]);
    // The press was consumed: no reselect happened (one selection, the original).
    expect(rig.overlay.selections).toEqual([7]);
  });

  it('Shift+click emits Rotate with ccw:true', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    selectWithHandle(rig, handlePt);

    rig.canvas.fire('pointerdown', {
      button: 0,
      target: rig.canvas,
      ...atPx(handlePt.x, handlePt.y),
    });
    rig.win.fire('pointerup', {
      button: 0,
      shiftKey: true,
      target: rig.canvas,
      ...atPx(handlePt.x, handlePt.y),
    });

    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({ kind: 'Rotate', node: 7, ccw: true }),
    ]);
  });

  it('down inside but up outside the radius emits NOTHING (gesture cancelled)', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    selectWithHandle(rig, handlePt);

    rig.canvas.fire('pointerdown', {
      button: 0,
      target: rig.canvas,
      ...atPx(handlePt.x, handlePt.y),
    });
    rig.win.fire('pointerup', {
      button: 0,
      shiftKey: false,
      target: rig.canvas,
      ...atPx(400, 400),
    });

    expect(rig.sent).toHaveLength(0);
    // Pan restored after the consumed press.
    expect(rig.panState.enabled).toBe(true);
  });

  it('hovering the handle sets hover styling + cursor pointer; leaving restores both', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    selectWithHandle(rig, handlePt);

    rig.win.fire('pointermove', {
      target: rig.canvas,
      ...atPx(handlePt.x + 3, handlePt.y),
    });
    expect(rig.overlay.rotateHoverCalls.at(-1)).toBe(true);
    expect(rig.cursor()).toBe('pointer');

    rig.win.fire('pointermove', { target: rig.canvas, ...atPx(500, 500) });
    expect(rig.overlay.rotateHoverCalls.at(-1)).toBe(false);
    expect(rig.cursor()).toBe('');
  });

  it('keyboard r with a node selected still emits the identical Rotate frame (regression)', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    selectWithHandle(rig, handlePt);

    rig.win.fire('keydown', { key: 'r', shiftKey: false, preventDefault: () => {} });

    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({ kind: 'Rotate', node: 7, ccw: false }),
    ]);
  });
});

describe('Draw-belt gesture (palette Belt tool)', () => {
  /** Drag a path: down on the first cell, move through the rest, up to commit. */
  const dragPath = (r: Rig, cells: Array<[number, number]>): void => {
    r.canvas.fire('pointerdown', {
      button: 0,
      target: r.canvas,
      ...at(cells[0][0], cells[0][1]),
    });
    for (let i = 1; i < cells.length; i++) {
      r.win.fire('pointermove', {
        target: r.canvas,
        ...at(cells[i][0], cells[i][1]),
      });
    }
    r.win.fire('pointerup', { button: 0, target: r.canvas });
  };

  it('arming the Belt tool suspends camera pan', () => {
    rig = setupRig();
    expect(rig.panState.enabled).toBe(true);
    rig.armBelt();
    expect(rig.panState.enabled).toBe(false);
  });

  it('a legal L-path drag emits exactly one DrawBelt (disc 3) with the drawn cells', () => {
    rig = setupRig();
    rig.armBelt();
    // An orthogonal L: (2,2)->(3,2)->(3,3) — every step adjacent, no overlap.
    const cells: Array<[number, number]> = [
      [2, 2],
      [3, 2],
      [3, 3],
    ];
    dragPath(rig, cells);

    expect(rig.sent).toHaveLength(1);
    // DrawBelt is disc 3 after the 17-02 Wire removal renumber (was 4).
    expect(rig.sent[0][0]).toBe(3); // DrawBelt discriminant
    // The committed bytes carry the 3 drawn integer cells (varintU count then
    // zigzag varintI pairs): disc=3, len=3, then (2,2)(3,2)(3,3) as zigzag.
    expect([...rig.sent[0]]).toEqual([3, 3, 4, 4, 6, 4, 6, 6]);
    // The last preview before commit was build-blue (valid).
    expect(rig.overlay.beltCalls.at(-1)?.valid).toBe(true);
  });

  it('a self-crossing path renders red, is sent, and flashes the first cell it revisits', () => {
    rig = setupRig();
    rig.armBelt();
    // Revisit (2,2): ...(3,3)->(2,3)->(2,2) - (2,2) is adjacent to (2,3) so it is
    // appended, and route() reports SelfCrossing, so the preview is red. Since plan 89-09
    // (D-13) the release still SENDS the drawn cells, so the host answers RouteSelfCrossing in
    // words, and the one flash names the first drawn cell the path revisits (D-12).
    const drawn: Array<[number, number]> = [
      [2, 2],
      [3, 2],
      [3, 3],
      [2, 3],
      [2, 2],
    ];
    dragPath(rig, drawn);

    expect(rig.overlay.beltCalls.at(-1)?.valid).toBe(false);
    const frame = expectIllegalDrawSent(rig, 'the self-crossing release');
    expect([...frame], 'the drawn cells, revisit included').toEqual([...encodeGridCommand({ kind: 'DrawBelt', cells: drawn })]);
    expect(rig.overlay.rejectFlashCalls.map((c) => c.cell), 'ONE flash, on the revisited cell').toEqual([{ cx: 2, cy: 2 }]);
  });

  it('a path crossing an occupied machine cell renders red, is sent, and flashes that cell', () => {
    // A 1x1 machine sits at (3,2): a belt drawn through it overlaps, so the preview is red.
    // Since plan 89-09 (D-13) the release is sent all the same, and the host answers
    // FootprintCollision; the one flash is on the machine cell (D-12).
    rig = setupRig(node({ id: 9, cell_x: 3, cell_y: 2 }));
    rig.armBelt();
    const drawn: Array<[number, number]> = [
      [2, 2],
      [3, 2],
      [4, 2],
    ];
    dragPath(rig, drawn);

    expect(rig.overlay.beltCalls.at(-1)?.valid).toBe(false);
    const frame = expectIllegalDrawSent(rig, 'the release across a machine');
    expect([...frame], 'the drawn cells').toEqual([...encodeGridCommand({ kind: 'DrawBelt', cells: drawn })]);
    expect(rig.overlay.rejectFlashCalls.map((c) => c.cell), 'ONE flash, on the machine cell').toEqual([{ cx: 3, cy: 2 }]);
  });

  it('a_1025_tile_snake_previews_red_and_sends_1025_cells', () => {
    // W251, T-89-22 (plan 89-09, D-12): the host refuses a belt of more than MAX_BELT_TILES (1024)
    // tiles as BeltTooLong, so the preview turns red at tile 1025. A serpentine of 41 by 25 cells
    // is exactly 1025 tiles; the hand goes on five cells more. The release sends the first 1025
    // cells (one tile past the cap, enough for the host to answer BeltTooLong, the frame bounded),
    // with no claim, and the one flash is the first tile past the cap.
    rig = setupRig();
    rig.armBelt();
    const snake: Array<[number, number]> = [];
    for (let y = 0; y < 25; y++) {
      for (let i = 0; i < 41; i++) {
        snake.push([y % 2 === 0 ? i : 40 - i, y]);
      }
    }
    // Row 24 ran left to right and ends at x 40, so the five cells more run right to left from 40.
    for (let i = 0; i < 5; i++) {
      snake.push([40 - i, 25]);
    }
    expect(snake.length, 'NON-VACUITY: 1030 cells').toBe(1030);
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(snake[0][0], snake[0][1]) });
    let validAt1024: boolean | undefined;
    for (let i = 1; i < snake.length; i++) {
      rig.win.fire('pointermove', { target: rig.canvas, ...at(snake[i][0], snake[i][1]) });
      if (i === 1023) {
        validAt1024 = rig.overlay.beltCalls.at(-1)?.valid;
      }
    }
    expect(rig.overlay.beltCalls.at(-1)?.tiles.length, 'NON-VACUITY: the walk took every cell').toBe(1030);
    expect(validAt1024, 'at 1024 tiles the preview is still the build colour').toBe(true);
    expect(rig.overlay.beltCalls.at(-1)?.valid, 'past 1024 tiles the preview is red').toBe(false);
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(snake[1029][0], snake[1029][1]) });
    const frame = expectIllegalDrawSent(rig, 'the over-long release');
    expect([...frame], 'the first 1025 cells, one tile past the cap').toEqual([
      ...encodeGridCommand({ kind: 'DrawBelt', cells: snake.slice(0, 1025) }),
    ]);
    expect(rig.overlay.rejectFlashCalls.map((c) => c.cell), 'ONE flash, on the first tile past the cap').toEqual([
      { cx: snake[1024][0], cy: snake[1024][1] },
    ]);
  });

  // =========================================================================
  // A REAL HAND, plan 74-14. A manual test drew belts on the WebKitGTK binary and
  // reported three things: corners do not draw, a skipped cell freezes the
  // path, and an illegal cell leaves the belt red and stuck.
  //
  // What every belt-draw fixture ABOVE shares, and a hand does not: it advances
  // such that no sample is ever more than one cell from the head. `dragPath`
  // teleports cell to cell. So does `dragPortToPort`, so do the mock e2e drags,
  // so does the live `drawBeltThroughCells`. The shipped suite therefore CANNOT
  // fail on any of the three, and a fix verified against it is verified by a
  // check that cannot fail. Every case below emits at least one sample that is
  // sub-cell or multi-cell, which is the input alphabet no fixture produced.
  // =========================================================================

  /** A WORLD cell centre as a client point, for the `cellsFromWorld` cases below. */
  const centreAt = (cx: number, cy: number) => ({
    clientX: cx * CELL + CELL / 2,
    clientY: cy * CELL + CELL / 2,
  });

  it('a diagonal elbow sample draws the corner it swept, not the straight leg it started', () => {
    // ONE-VARIABLE DIFFERENCE from `a legal L-path drag emits exactly one DrawBelt`
    // above: that case reaches the same three cells in TWO teleporting samples, this
    // one reaches them in ONE sample whose cell coordinates BOTH change. At an elbow
    // a hand necessarily has both velocity components for a stretch, which is why
    // "corners do not work" is the sentence the one-cell admission test produces.
    rig = setupRig();
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(2, 2) });
    // The whole experiment, in one line: a single diagonal sample.
    rig.win.fire('pointermove', { target: rig.canvas, ...at(3, 3) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(3, 3) });

    expect(rig.sent).toHaveLength(1);
    // THE SAME BYTES the teleporting L above commits, reached in one sample. And
    // these exact bytes pin the lattice-corner tie-break and nothing else does: the
    // segment from (2.5,2.5) to (3.5,2.5+1) crosses x=3 and y=3 at the SAME
    // parameter, so stepping X first yields (3,2) as the middle cell and stepping Y
    // first would yield (2,3). Fixed choice: X first.
    expect([...rig.sent[0]]).toEqual([3, 3, 4, 4, 6, 4, 6, 6]);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({
        kind: 'DrawBelt',
        cells: [
          [2, 2],
          [3, 2],
          [3, 3],
        ],
      }),
    ]);
    expect(rig.overlay.beltCalls.at(-1)?.valid).toBe(true);
    expect(
      rig.overlay.beltCalls.filter((c) => c.tiles.length === 0),
      'no showBeltPreview call in the gesture carried an EMPTY tile list',
    ).toHaveLength(0);
  });

  it('a sample that skips two cells fills the cells the cursor crossed', () => {
    // ONE-VARIABLE DIFFERENCE from the elbow above: the sample is STRAIGHT, and
    // three cells long instead of one diagonal. This is the second reported symptom,
    // "if my mouse skips a cell, the belt doesn't continue to the current cell
    // location": at HEAD the sample is dropped, the head never advances, and every
    // later sample is further from it than the one before.
    rig = setupRig();
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(2, 3) });
    rig.win.fire('pointermove', { target: rig.canvas, ...at(5, 3) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(5, 3) });

    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({
        kind: 'DrawBelt',
        cells: [
          [2, 3],
          [3, 3],
          [4, 3],
          [5, 3],
        ],
      }),
    ]);
    expect(rig.overlay.beltCalls.at(-1)?.valid).toBe(true);
  });

  it('a sample landing EXACTLY on a lattice corner while moving down-left is walked to that corner cell, not past it', () => {
    // Found by the 74.1-05 corner matrix, whose press grid is aligned on the tile corner.
    // `walkCellsBetween` steps X first on a tie. Moving -x and +y into a sample that sits
    // exactly on a lattice corner, the last x boundary (x = 5.0, which `Math.floor` keeps
    // in cell 5) and the last y boundary are both crossed at t = 1. X won the tie, stepped
    // to cell 4, and the walk could never come back to (5, 6): it ran to the
    // BELT_WALK_MAX_CELLS bound and returned NOTHING, so every cell of that segment was
    // dropped. A later sample then walks from a cell that is no longer next to the head,
    // and the path freezes for good: a blue belt that stops behind the hand.
    //
    // Every number is exact in binary: press (180, 108) is frac (5.625, 3.375), the corner
    // (160, 192) is frac (5, 6), dx = -0.625 and dy = 2.625, so both final crossings sit at
    // exactly t = 1.
    rig = setupRigWith({ cellsFromWorld: true });
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, clientX: 180, clientY: 108 });
    rig.win.fire('pointermove', { target: rig.canvas, clientX: 160, clientY: 192 });
    const head = rig.overlay.beltCalls.at(-1)?.tiles.at(-1);
    expect(
      [head?.cell_x, head?.cell_y],
      'after the corner sample the head is the corner cell, (5, 6)',
    ).toEqual([5, 6]);
    rig.win.fire('pointermove', { target: rig.canvas, clientX: 160, clientY: 256 });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, clientX: 160, clientY: 256 });

    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({
        kind: 'DrawBelt',
        cells: [
          [5, 3],
          [5, 4],
          [5, 5],
          [5, 6],
          [5, 7],
          [5, 8],
        ],
      }),
    ]);
    expect(rig.overlay.beltCalls.at(-1)?.valid).toBe(true);
  });

  it('the mirror case: a long up-right sample onto a lattice corner whose tie ROUNDS toward y still ends on that corner cell', () => {
    // The y half of the same guard. Moving +x and -y into a lattice corner, x wins an EXACT
    // tie, so only floating point can send y first: the y parameter is accumulated 104
    // times and lands a hair under the x one. Found by searching, not reasoned: press
    // (548, 3864) is frac (17.125, 120.75) and the corner (576, 512) is frac (18, 16), the
    // MIN_ZOOM screen pair (137, 966) -> (144, 128). Without `cy === ey` the walk steps y
    // to row 15, past the end, and drops the whole segment.
    rig = setupRigWith({ cellsFromWorld: true });
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, clientX: 548, clientY: 3864 });
    rig.win.fire('pointermove', { target: rig.canvas, clientX: 576, clientY: 512 });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, clientX: 576, clientY: 512 });

    const column: Array<[number, number]> = [];
    for (let y = 120; y >= 16; y--) column.push([17, y]);
    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({ kind: 'DrawBelt', cells: [...column, [18, 16]] }),
    ]);
  });

  it('dragging back the way you came unwinds the path one cell per cell', () => {
    // The third reported symptom: "if I go to a not allowed cell, and then want to go
    // back to the allowed cell with a drag, the belt remain red and stuck on the
    // unallowed cell". At HEAD `drawnCells` can only ever be PUSHED, so one wrong
    // cell ends the drag: the retreat sample re-enters a cell that is adjacent to
    // the head, gets appended, and the path self-crosses for good.
    //
    // ONE-VARIABLE DIFFERENCE from the shipped occupancy case above: the drag does
    // not stop at the machine, it comes BACK. The machine stays where it was.
    rig = setupRigWith({ cellsFromWorld: true }, node({ id: 9, cell_x: 4, cell_y: 3 }));
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...centreAt(2, 3) });
    rig.win.fire('pointermove', { target: rig.canvas, ...centreAt(3, 3) });
    rig.win.fire('pointermove', { target: rig.canvas, ...centreAt(4, 3) });
    // The machine's tile is APPENDED and paints red - that is the shipped decision
    // and it is not touched here.
    expect(rig.overlay.beltCalls.at(-1)?.tiles.length).toBe(3);
    expect(rig.overlay.beltCalls.at(-1)?.valid).toBe(false);
    // The retreat: back into the cell immediately behind the head.
    rig.win.fire('pointermove', { target: rig.canvas, ...centreAt(3, 3) });

    const last = rig.overlay.beltCalls.at(-1);
    expect(last?.tiles.length, 'the head popped, so the preview is the shorter path').toBe(2);
    expect(last?.valid, 'and it is build-blue again: the red unwound with the path').toBe(true);

    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...centreAt(3, 3) });
    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({
        kind: 'DrawBelt',
        cells: [
          [2, 3],
          [3, 3],
        ],
      }),
    ]);
  });

  it('one fast backward sweep pops as many cells as it crosses', () => {
    // THE LOAD-BEARING RETREAT CASE. ONE-VARIABLE DIFFERENCE from the case above:
    // the retreat happens in a SINGLE sample instead of one sample per cell.
    // Recovery has to be exactly as fast as poisoning, or the walk ships a trap
    // that is easier to enter than to leave: a hand that can poison three cells in
    // one flick must be able to unwind three cells in one flick.
    rig = setupRigWith({ cellsFromWorld: true }, node({ id: 9, cell_x: 4, cell_y: 3 }));
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...centreAt(2, 3) });
    rig.win.fire('pointermove', { target: rig.canvas, ...centreAt(3, 3) });
    rig.win.fire('pointermove', { target: rig.canvas, ...centreAt(4, 3) });
    expect(rig.overlay.beltCalls.at(-1)?.tiles.length).toBe(3);
    // One sample, from inside the machine's tile all the way back to the seed.
    rig.win.fire('pointermove', { target: rig.canvas, ...centreAt(2, 3) });

    const last = rig.overlay.beltCalls.at(-1);
    expect(last?.tiles.length, 'both cells popped in the one sample').toBe(1);
    expect(last?.valid).toBe(true);

    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...centreAt(2, 3) });
    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({ kind: 'DrawBelt', cells: [[2, 3]] }),
    ]);
  });

  it('closing a loop onto the middle of your own path still goes red', () => {
    // THE DELIBERATE RED SURVIVES, and this is the case that tells a correct pop
    // from a lazy one. The retreat rule pops ONLY the cell immediately behind the
    // head. Here the head is (3,3), the cell behind it is (4,3), and the cell the
    // cursor re-enters is (3,2) - index 1 of the path, three back. It APPENDS,
    // route() answers SelfCrossing, and the release sends the six cells, the revisit
    // included, with no claim (plan 89-09, D-13), so the host answers RouteSelfCrossing.
    //
    // ONE-VARIABLE DIFFERENCE from `a self-crossing path renders red` above: the
    // first sample is a two-cell jump, so the loop is closed by a hand rather than
    // by a teleport. A pop widened to "any revisit" would make this case GREEN with
    // a command, which is why mutation M4 exists.
    rig = setupRigWith({ cellsFromWorld: true });
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...centreAt(2, 2) });
    rig.win.fire('pointermove', { target: rig.canvas, ...centreAt(4, 2) });
    rig.win.fire('pointermove', { target: rig.canvas, ...centreAt(4, 3) });
    rig.win.fire('pointermove', { target: rig.canvas, ...centreAt(3, 3) });
    // Four cells drawn: (2,2)(3,2)(4,2)(4,3)(3,3) - five, and the next one closes it.
    expect(rig.overlay.beltCalls.at(-1)?.tiles.length).toBe(5);
    expect(rig.overlay.beltCalls.at(-1)?.valid).toBe(true);
    rig.win.fire('pointermove', { target: rig.canvas, ...centreAt(3, 2) });

    expect(rig.overlay.beltCalls.at(-1)?.valid, 'the closed loop is red').toBe(false);
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...centreAt(3, 2) });
    const frame = expectIllegalDrawSent(rig, 'the closed loop');
    expect([...frame], 'and the illegal path is sent as drawn, the revisit appended, not popped').toEqual([
      ...encodeGridCommand({
        kind: 'DrawBelt',
        cells: [
          [2, 2],
          [3, 2],
          [4, 2],
          [4, 3],
          [3, 3],
          [3, 2],
        ],
      }),
    ]);
    expect(rig.overlay.rejectFlashCalls.map((c) => c.cell), 'ONE flash, on the revisited cell').toEqual([{ cx: 3, cy: 2 }]);
  });

  it('Esc disarms the tool and restores camera pan', () => {
    rig = setupRig();
    rig.armBelt();
    expect(rig.panState.enabled).toBe(false);
    rig.win.fire('keydown', { key: 'Escape', preventDefault: () => {} });
    expect(rig.panState.enabled).toBe(true);
    // After disarm, a drag emits nothing (mode is off).
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(5, 5) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas });
    expect(rig.sent).toHaveLength(0);
  });

  it('right-click cancels the armed tool and restores pan', () => {
    rig = setupRig();
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 2, target: rig.canvas, ...at(5, 5) });
    expect(rig.panState.enabled).toBe(true);
    expect(rig.sent).toHaveLength(0);
  });

  it('a node->node drag no longer wires (Wire gesture removed in 17-02)', () => {
    // Two nodes far apart: pressing one and dragging onto the other used to emit a
    // Wire command. After the 17-02 Wire removal, belts come ONLY from the DrawBelt
    // tool + Dock — a machine->machine drag emits NO command (it resolves to a
    // select of the pressed node, no wire).
    rig = setupRig(
      node({ id: 1, cell_x: 2, cell_y: 2 }),
      node({ id: 2, cell_x: 12, cell_y: 2 }),
    );
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(2, 2) });
    rig.win.fire('pointermove', { target: rig.canvas, ...at(12, 2) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(12, 2) });
    expect(rig.sent).toHaveLength(0); // no Wire — the gesture is gone
  });

  // ---------------------------------------------------------------------------
  // Phase 89 red-first probes (plan 89-01, D-01, D-16). Each was gated and seen red at
  // PHASE89_START, and the plan that fixed it turned it on: that plan removed the gate and the
  // red-first title suffix and changed nothing else, so the test that is green is the test that
  // was seen red. Since plan 89-09 none is gated. Each prints its
  // measured facts on `P89-` lines before it asserts. Every drag below moves in sub-cell
  // samples, never one clean cell per event.
  // ---------------------------------------------------------------------------

  /** A pointer event at a fractional legacy-rig point (screen px == cell units here). */
  const p89At = (x: number, y: number) => ({ clientX: x, clientY: y });
  /** Walk the legacy rig's pointer from (x0,y) to (x1,y) in quarter-cell samples. */
  const p89Walk = (r: Rig, x0: number, x1: number, y: number, extra: Record<string, unknown> = {}): void => {
    const dir = Math.sign(x1 - x0);
    for (let x = x0; dir * (x1 - x) > 0; x += dir * 0.25) {
      r.win.fire('pointermove', { target: r.canvas, ...p89At(x, y), ...extra });
    }
    r.win.fire('pointermove', { target: r.canvas, ...p89At(x1, y), ...extra });
  };
  const p89DrawBelt = (cells: Array<[number, number]>): number[] => [...encodeGridCommand({ kind: 'DrawBelt', cells })];

  it(
    'a_middle_press_with_the_belt_tool_armed_keeps_the_tool_and_the_path',
    () => {
      // W244 (D-11): the middle button pans and never cancels. A middle press and release between
      // draws leaves the Belt tool armed, and the draw after it lays its path whole.
      //
      // Review WR-C-07: this case used to fire a middle `pointerdown` DURING the left draw and walk
      // on with no `buttons`, and pinned the cells crossed after it INTO the path, the opposite of
      // the D-11 rule for the same action. No engine sends that shape: a middle press inside a left
      // drag reaches the page as a `pointermove` whose `buttons` gains bit 4, never as a down
      // (Chromium, 89-07 research A5; WebKitGTK, measured on the shipped binary in review pass 2).
      // The real shape is pinned by `a_chorded_middle_press_neither_extends_nor_commits`, so the
      // mid-draw half is gone and this case keeps the between-draws press, which is real.
      rig = setupRig();
      rig.armBelt();
      rig.canvas.fire('pointerdown', { button: 1, target: rig.canvas, ...at(9, 9) });
      rig.win.fire('pointerup', { button: 1, target: rig.canvas, ...at(9, 9) });
      const armedAfterPan = rig.armedCalls.at(-1);
      rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(2, 2) });
      p89Walk(rig, 2.5, 4.5, 2.5);
      rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(4, 2) });
      console.log(`P89-W244 armed_after_pan=${JSON.stringify(armedAfterPan)} armed_calls=${JSON.stringify(rig.armedCalls)} sent=${JSON.stringify(rig.sent.map((f) => [...f]))}`);
      expect(armedAfterPan, 'a middle press and release between draws keeps the Belt tool').toEqual({ kind: 'belt' });
      expect(rig.sent.map((f) => [...f]), 'the draw after the middle press lays its path whole').toEqual([
        p89DrawBelt([
          [2, 2],
          [3, 2],
          [4, 2],
        ]),
      ]);
      expect(rig.armedCalls.at(-1), 'the tool is still armed').toEqual({ kind: 'belt' });
    },
  );

  it(
    'a_pointercancel_mid_draw_drops_the_path_and_keeps_the_tool',
    () => {
      // W245 (D-11): a `pointercancel` mid-draw (an OS gesture, a webview that drops the release)
      // throws the path away and keeps the tool: no belt is laid that the user did not release,
      // a stray release after it sends nothing, and a fresh drag draws normally.
      rig = setupRig();
      rig.armBelt();
      rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(2, 2) });
      p89Walk(rig, 2.5, 4.5, 2.5);
      rig.win.fire('pointercancel', { target: rig.canvas, ...at(4, 2) });
      const previewAfterCancel = rig.overlay.beltPreview.on;
      p89Walk(rig, 4.5, 5.5, 2.5);
      rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(5, 2) });
      const sentAfterCancel = rig.sent.map((f) => [...f]);
      rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(2, 6) });
      p89Walk(rig, 2.5, 3.5, 6.5);
      rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(3, 6) });
      console.log(
        `P89-W245 preview_on_after_cancel=${String(previewAfterCancel)} sent_after_cancel=${JSON.stringify(sentAfterCancel)} sent=${JSON.stringify(rig.sent.map((f) => [...f]))} capture=${JSON.stringify(rig.captureCalls)}`,
      );
      expect(previewAfterCancel, 'the cancel took the preview down').toBe(false);
      expect(sentAfterCancel, 'nothing was laid for the cancelled path').toEqual([]);
      expect(rig.armedCalls.at(-1), 'the tool is still armed').toEqual({ kind: 'belt' });
      expect(rig.sent.map((f) => [...f]), 'a fresh drag draws normally').toEqual([
        p89DrawBelt([
          [2, 6],
          [3, 6],
        ]),
      ]);
    },
  );

  it(
    'a_keyframe_mid_draw_keeps_the_drawn_path',
    () => {
      // W246 (D-11): a full keyframe mid-draw (App calls `clearSelection`) keeps the plain-seeded
      // path; the release sends every drawn cell.
      rig = setupRig();
      rig.armBelt();
      rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(2, 2) });
      p89Walk(rig, 2.5, 4.5, 2.5);
      rig.clearSel();
      const previewAfterKeyframe = rig.overlay.beltPreview.on;
      p89Walk(rig, 4.5, 5.5, 2.5);
      rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(5, 2) });
      console.log(`P89-W246 preview_on_after_keyframe=${String(previewAfterKeyframe)} sent=${JSON.stringify(rig.sent.map((f) => [...f]))}`);
      expect(rig.sent.map((f) => [...f]), 'ONE DrawBelt with every drawn cell').toEqual([
        p89DrawBelt([
          [2, 2],
          [3, 2],
          [4, 2],
          [5, 2],
        ]),
      ]);
    },
  );

  it(
    'the_first_escape_mid_draw_cancels_only_the_path',
    () => {
      // W247 (D-11): Escape mid-draw cancels the path and keeps the tool; the release after it sends
      // nothing; a second Escape puts the tool away.
      rig = setupRig();
      rig.armBelt();
      rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(2, 2) });
      p89Walk(rig, 2.5, 4.5, 2.5);
      rig.win.fire('keydown', { key: 'Escape', preventDefault: () => {} });
      const armedAfterFirst = rig.armedCalls.at(-1);
      const previewAfterFirst = rig.overlay.beltPreview.on;
      p89Walk(rig, 4.5, 5.5, 2.5);
      rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(5, 2) });
      const sentAfterFirst = rig.sent.map((f) => [...f]);
      rig.win.fire('keydown', { key: 'Escape', preventDefault: () => {} });
      console.log(
        `P89-W247 armed_after_first=${JSON.stringify(armedAfterFirst)} preview_on_after_first=${String(previewAfterFirst)} sent_after_first=${JSON.stringify(sentAfterFirst)} armed_calls=${JSON.stringify(rig.armedCalls)}`,
      );
      expect(armedAfterFirst, 'the first Escape keeps the Belt tool').toEqual({ kind: 'belt' });
      expect(previewAfterFirst, 'and takes the path down').toBe(false);
      expect(sentAfterFirst, 'the release after it sends nothing').toEqual([]);
      expect(rig.armedCalls.at(-1), 'the second Escape puts the tool away').toBeNull();
    },
  );

  it(
    'a_second_pointer_during_a_draw_is_ignored',
    () => {
      // W253 (D-11): the draw is owned by the pointer that pressed it. A second pointer going down,
      // moving and lifting mid-draw is ignored; the first pointer's release sends exactly its cells.
      rig = setupRig();
      rig.armBelt();
      rig.canvas.fire('pointerdown', { button: 0, pointerId: 1, target: rig.canvas, ...at(2, 2) });
      p89Walk(rig, 2.5, 3.5, 2.5, { pointerId: 1 });
      rig.canvas.fire('pointerdown', { button: 0, pointerId: 2, target: rig.canvas, ...at(8, 8) });
      p89Walk(rig, 8.5, 9.5, 8.5, { pointerId: 2 });
      rig.win.fire('pointerup', { button: 0, pointerId: 2, target: rig.canvas, ...at(9, 8) });
      p89Walk(rig, 3.5, 4.5, 2.5, { pointerId: 1 });
      rig.win.fire('pointerup', { button: 0, pointerId: 1, target: rig.canvas, ...at(4, 2) });
      console.log(`P89-W253 sent=${JSON.stringify(rig.sent.map((f) => [...f]))} capture=${JSON.stringify(rig.captureCalls)}`);
      expect(rig.sent.map((f) => [...f]), "ONE DrawBelt with exactly pointer 1's cells").toEqual([
        p89DrawBelt([
          [2, 2],
          [3, 2],
          [4, 2],
        ]),
      ]);
      expect(rig.armedCalls.at(-1), 'the tool is still armed').toEqual({ kind: 'belt' });
    },
  );

  // ---------------------------------------------------------------------------
  // Phase 89, plan 89-07 (BELT-08, D-11): one pointer owns a draw, and a cancel, a lost capture,
  // a blur or a lost release throws the path away and keeps the tool. Beside the W253 and W245
  // probes above, in the same legacy rig and the same quarter-cell walks.
  // ---------------------------------------------------------------------------

  /** The cells the last preview call painted, as `[x, y]` pairs. */
  const p89Shown = (r: Rig): string => JSON.stringify(r.overlay.beltCalls.at(-1)?.tiles.map((t) => [t.cell_x, t.cell_y]) ?? null);

  it('every_event_of_a_non_owning_pointer_leaves_the_draw_unchanged', () => {
    // The assumption-delta invariant (plan 89-07, `promote`): the owning pointer id IS the draw's
    // identity. For a down, a move, a move with no button, an up, a cancel and a lost capture of
    // pointer 2 during pointer 1's draw, the drawn cells, the preview call count, the preview's
    // presence and the sent frames are all unchanged.
    const r = setupRig();
    rig = r;
    r.armBelt();
    r.canvas.fire('pointerdown', { button: 0, buttons: 1, pointerId: 1, target: r.canvas, ...at(2, 2) });
    p89Walk(r, 2.5, 3.5, 2.5, { pointerId: 1, buttons: 1 });
    const want = { cells: p89Shown(r), calls: r.overlay.beltCalls.length, on: r.overlay.beltPreview.on, sent: r.sent.length };
    expect(want.cells, 'NON-VACUITY: pointer 1 drew two cells').toBe('[[2,2],[3,2]]');
    const reads: Record<string, boolean> = {};
    const read = (step: string): void => {
      reads[step] =
        p89Shown(r) === want.cells &&
        r.overlay.beltCalls.length === want.calls &&
        r.overlay.beltPreview.on === want.on &&
        r.sent.length === want.sent;
    };
    rig.canvas.fire('pointerdown', { button: 0, buttons: 1, pointerId: 2, target: rig.canvas, ...at(8, 8) });
    read('down');
    p89Walk(rig, 8.5, 9.5, 8.5, { pointerId: 2, buttons: 1 });
    read('move');
    rig.win.fire('pointermove', { pointerId: 2, buttons: 0, target: rig.canvas, ...at(9, 8) });
    read('move with no button');
    rig.win.fire('pointerup', { button: 0, buttons: 0, pointerId: 2, target: rig.canvas, ...at(9, 8) });
    read('up');
    rig.win.fire('pointercancel', { pointerId: 2, target: rig.canvas, ...at(9, 8) });
    read('cancel');
    rig.canvas.fire('lostpointercapture', { pointerId: 2, target: rig.canvas });
    read('lost capture');
    console.log(`P89-W253 invariant reads=${JSON.stringify(reads)}`);
    expect(reads, "no event of pointer 2 touched pointer 1's draw").toEqual({
      down: true,
      move: true,
      'move with no button': true,
      up: true,
      cancel: true,
      'lost capture': true,
    });
    // The owner still owns it: its walk extends the path and its release sends exactly its cells.
    p89Walk(rig, 3.5, 4.5, 2.5, { pointerId: 1, buttons: 1 });
    rig.win.fire('pointerup', { button: 0, buttons: 0, pointerId: 1, target: rig.canvas, ...at(4, 2) });
    expect(rig.sent.map((f) => [...f]), "ONE DrawBelt with pointer 1's cells").toEqual([
      p89DrawBelt([
        [2, 2],
        [3, 2],
        [4, 2],
      ]),
    ]);
  });

  it('a_left_press_again_by_the_owner_starts_a_fresh_draw', () => {
    // Review WR-B-03 (b): the release of pointer 1's draw was lost (WebKitGTK outside the window),
    // and the next left press of the SAME pointer arrives before any move. A pointer cannot be
    // pressed twice, so that press proves the old release was lost: the old path is thrown away
    // and the press starts a fresh draw. Its release sends exactly the new cells. Red before the
    // fix: the second down was ignored, the old path walked on from its stale anchor, and the
    // release laid the old belt extended toward the new hand.
    rig = setupRig();
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, buttons: 1, pointerId: 1, target: rig.canvas, ...at(2, 2) });
    p89Walk(rig, 2.5, 4.5, 2.5, { pointerId: 1, buttons: 1 });
    expect(rig.overlay.beltPreview.on, 'NON-VACUITY: the first path is previewed').toBe(true);
    // No pointerup: the release is lost. The same pointer presses again at (6,5).
    rig.canvas.fire('pointerdown', { button: 0, buttons: 1, pointerId: 1, target: rig.canvas, ...at(6, 5) });
    p89Walk(rig, 6.5, 8.5, 5.5, { pointerId: 1, buttons: 1 });
    rig.win.fire('pointerup', { button: 0, buttons: 0, pointerId: 1, target: rig.canvas, ...at(8, 5) });
    expect(rig.sent.map((f) => [...f]), 'ONE DrawBelt with only the new cells').toEqual([
      p89DrawBelt([
        [6, 5],
        [7, 5],
        [8, 5],
      ]),
    ]);
    expect(rig.armedCalls.at(-1), 'the tool is still armed').toEqual({ kind: 'belt' });
  });

  it('a_new_touch_after_the_owner_lost_its_capture_starts_a_fresh_draw', () => {
    // Review WR-B-03 (a): a touch draw by pointer 5 whose release and cancel were both lost. The
    // browser dropped its capture without telling the page. A new touch (pointer 6) is not a
    // second finger beside a live owner: the owner is gone, so the new touch draws. Red before the
    // fix: pointer 6 was a stranger forever and the board stopped answering touch. While the
    // owner still holds its capture, a second pointer stays ignored (the W253 case above).
    rig = setupRig();
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, buttons: 1, pointerId: 5, target: rig.canvas, ...at(2, 2) });
    p89Walk(rig, 2.5, 4.5, 2.5, { pointerId: 5, buttons: 1 });
    expect(rig.captureCalls.some((c) => c.op === 'set' && c.pointerId === 5), 'NON-VACUITY: the draw captured pointer 5').toBe(true);
    // The browser drops the capture with no event the page sees.
    (rig.canvas as unknown as { releasePointerCapture: (id: number) => void }).releasePointerCapture(5);
    rig.canvas.fire('pointerdown', { button: 0, buttons: 1, pointerId: 6, target: rig.canvas, ...at(6, 5) });
    p89Walk(rig, 6.5, 8.5, 5.5, { pointerId: 6, buttons: 1 });
    rig.win.fire('pointerup', { button: 0, buttons: 0, pointerId: 6, target: rig.canvas, ...at(8, 5) });
    expect(rig.sent.map((f) => [...f]), "ONE DrawBelt with pointer 6's cells").toEqual([
      p89DrawBelt([
        [6, 5],
        [7, 5],
        [8, 5],
      ]),
    ]);
  });

  it('a_new_press_after_a_no_tool_owner_was_lost_is_a_fresh_press', () => {
    // Review WR-B-03 (b) for a no-tool gesture: pointer 1 pressed a machine (a select candidate)
    // and its release was lost. Its next left press on another machine selects that one.
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }), node({ id: 8, cell_x: 6, cell_y: 2 }));
    rig.canvas.fire('pointerdown', { button: 0, buttons: 1, pointerId: 1, target: rig.canvas, ...at(2, 2) });
    rig.canvas.fire('pointerdown', { button: 0, buttons: 1, pointerId: 1, target: rig.canvas, ...at(6, 2) });
    rig.win.fire('pointerup', { button: 0, buttons: 0, pointerId: 1, target: rig.canvas, ...at(6, 2) });
    expect(rig.onSelectCalls.at(-1), 'the fresh press selected machine 8').toBe(8);
  });

  it('a_move_with_the_left_button_up_drops_the_path', () => {
    // A release the webview lost (WINDOWS 245, T-89-18): the owner's next move carries `buttons`
    // with the left bit clear. The path goes (preview off, the start disc unfilled, the resting
    // rings repainted), the tool stays, the later pointerup sends nothing, and a fresh drag draws.
    rig = setupRig();
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, buttons: 1, pointerId: 1, target: rig.canvas, ...at(2, 2) });
    p89Walk(rig, 2.5, 4.5, 2.5, { pointerId: 1, buttons: 1 });
    expect(rig.overlay.beltPreview.on, 'NON-VACUITY: the path is previewed').toBe(true);
    const rings = rig.overlay.dockTargetCalls.length;
    rig.win.fire('pointermove', { pointerId: 1, buttons: 0, target: rig.canvas, ...p89At(4.75, 2.5) });
    expect(rig.overlay.beltPreview.on, 'the lost release took the preview down').toBe(false);
    expect(rig.overlay.dockTargetCalls.length, 'the resting rings repainted').toBeGreaterThan(rings);
    expect(rig.armedCalls.at(-1), 'the tool is still armed').toEqual({ kind: 'belt' });
    p89Walk(rig, 4.75, 5.5, 2.5, { pointerId: 1, buttons: 0 });
    rig.win.fire('pointerup', { button: 0, buttons: 0, pointerId: 1, target: rig.canvas, ...at(5, 2) });
    expect(rig.sent, 'the later release sends nothing').toHaveLength(0);
    expect(rig.overlay.rejectFlashCalls, 'and flashes nothing (A15)').toHaveLength(0);
    expect(rig.clientRefusals, 'and says nothing (A15)').toEqual([]);
    rig.canvas.fire('pointerdown', { button: 0, buttons: 1, pointerId: 1, target: rig.canvas, ...at(2, 6) });
    p89Walk(rig, 2.5, 3.5, 6.5, { pointerId: 1, buttons: 1 });
    rig.win.fire('pointerup', { button: 0, buttons: 0, pointerId: 1, target: rig.canvas, ...at(3, 6) });
    expect(rig.sent.map((f) => [...f]), 'a fresh drag draws').toEqual([
      p89DrawBelt([
        [2, 6],
        [3, 6],
      ]),
    ]);
  });

  it('a_move_without_a_buttons_field_is_not_a_lost_release', () => {
    // The rig's own events, and every case above this block, carry no `buttons` field; neither do
    // they here, with a pointer id. The draw extends and the release commits it whole.
    rig = setupRig();
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, pointerId: 1, target: rig.canvas, ...at(2, 2) });
    p89Walk(rig, 2.5, 4.5, 2.5, { pointerId: 1 });
    rig.win.fire('pointerup', { button: 0, pointerId: 1, target: rig.canvas, ...at(4, 2) });
    expect(rig.sent.map((f) => [...f]), 'ONE DrawBelt with every walked cell').toEqual([
      p89DrawBelt([
        [2, 2],
        [3, 2],
        [4, 2],
      ]),
    ]);
  });

  it('lost_pointer_capture_drops_the_path', () => {
    // The owner's capture lost on the canvas (an OS gesture, the webview taking the pointer): the
    // path goes, the tool stays, the later release sends nothing.
    rig = setupRig();
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, buttons: 1, pointerId: 3, target: rig.canvas, ...at(2, 2) });
    p89Walk(rig, 2.5, 4.5, 2.5, { pointerId: 3, buttons: 1 });
    expect(rig.overlay.beltPreview.on, 'NON-VACUITY: the path is previewed').toBe(true);
    rig.canvas.fire('lostpointercapture', { pointerId: 3, target: rig.canvas });
    expect(rig.overlay.beltPreview.on, 'the lost capture took the preview down').toBe(false);
    expect(rig.armedCalls.at(-1), 'the tool is still armed').toEqual({ kind: 'belt' });
    rig.win.fire('pointerup', { button: 0, buttons: 0, pointerId: 3, target: rig.canvas, ...at(4, 2) });
    expect(rig.sent, 'the later release sends nothing').toHaveLength(0);
  });

  it('a_window_blur_mid_draw_drops_the_path', () => {
    // The window loses focus mid-draw (the user switched away holding the button): the release
    // may never come back to this page, so the path goes and the tool stays.
    rig = setupRig();
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, pointerId: 1, target: rig.canvas, ...at(2, 2) });
    p89Walk(rig, 2.5, 4.5, 2.5, { pointerId: 1 });
    rig.win.fire('blur', {});
    expect(rig.overlay.beltPreview.on, 'the blur took the preview down').toBe(false);
    expect(rig.armedCalls.at(-1), 'the tool is still armed').toEqual({ kind: 'belt' });
    rig.win.fire('pointerup', { button: 0, pointerId: 1, target: rig.canvas, ...at(4, 2) });
    expect(rig.sent, 'the later release sends nothing').toHaveLength(0);
  });

  it('the_press_asks_for_pointer_capture', () => {
    // Pitfall 6: capture is asked for at the press, with the press's own id, once; a press with no
    // pointer id (the rig's plain events) asks for nothing.
    rig = setupRig();
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, pointerId: 5, target: rig.canvas, ...at(2, 2) });
    expect(rig.captureCalls, 'ONE capture call, for the pressing pointer').toEqual([{ op: 'set', pointerId: 5 }]);
    p89Walk(rig, 2.5, 3.5, 2.5, { pointerId: 5 });
    rig.win.fire('pointerup', { button: 0, pointerId: 5, target: rig.canvas, ...at(3, 2) });
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(2, 6) });
    expect(rig.captureCalls, 'a press with no pointer id asks for nothing more').toHaveLength(1);
  });

  it('a_capture_that_throws_still_draws', () => {
    // T-89-20: `setPointerCapture` throws `NotFoundError` for an id that is not an active pointer
    // (a synthetic event). The draw does not die with it: the stored id still owns the draw.
    rig = setupRig();
    let thrown = 0;
    (rig.canvas as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = () => {
      thrown += 1;
      throw new Error('NotFoundError: no active pointer with the given id');
    };
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, pointerId: 9, target: rig.canvas, ...at(2, 2) });
    p89Walk(rig, 2.5, 4.5, 2.5, { pointerId: 9 });
    rig.win.fire('pointerup', { button: 0, pointerId: 9, target: rig.canvas, ...at(4, 2) });
    expect(thrown, 'NON-VACUITY: the capture call threw').toBe(1);
    expect(rig.sent.map((f) => [...f]), 'ONE DrawBelt all the same').toEqual([
      p89DrawBelt([
        [2, 2],
        [3, 2],
        [4, 2],
      ]),
    ]);
  });

  it('destroy_removes_the_cancel_listeners', () => {
    // Each interruption listener leaves with the controller: after destroy() a cancel, a lost
    // capture and a blur reach nothing. A listener that leaked would run the path teardown on the
    // draw destroy() left behind, and the preview clear count would move. NON-VACUITY: on a live
    // controller the same cancel does move it.
    rig = setupRig();
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, pointerId: 1, target: rig.canvas, ...at(2, 2) });
    p89Walk(rig, 2.5, 3.5, 2.5, { pointerId: 1 });
    const live = rig.overlay.beltPreview.cleared;
    rig.win.fire('pointercancel', { pointerId: 1, target: rig.canvas });
    expect(rig.overlay.beltPreview.cleared, 'NON-VACUITY: a live cancel clears the preview').toBeGreaterThan(live);
    rig.canvas.fire('pointerdown', { button: 0, pointerId: 1, target: rig.canvas, ...at(2, 6) });
    p89Walk(rig, 2.5, 3.5, 6.5, { pointerId: 1 });
    rig.destroy();
    const after = { preview: rig.overlay.beltPreview.cleared, rings: rig.overlay.nubRingCleared.count };
    rig.win.fire('pointercancel', { pointerId: 1, target: rig.canvas });
    rig.canvas.fire('lostpointercapture', { pointerId: 1, target: rig.canvas });
    rig.win.fire('blur', {});
    expect(
      { preview: rig.overlay.beltPreview.cleared, rings: rig.overlay.nubRingCleared.count },
      'nothing ran after destroy()',
    ).toEqual(after);
  });

  // Plan 89-07 Task 2 (D-11, WINDOWS 244 and 247): the middle button pans, the right button and
  // Escape cancel the path before the tool.

  it('a_right_press_mid_draw_cancels_the_path_and_keeps_the_tool', () => {
    // Only the right button cancels, and the path first. Two shapes: the rig's right pointerdown,
    // and the real browser's, a move of the owner whose `buttons` gains the right bit (a right
    // press during a left drag is chorded into a move, research Pitfall 7).
    for (const shape of ['a right pointerdown', 'a move chorded with the right button'] as const) {
      rig?.destroy();
      rig = setupRig();
      rig.armBelt();
      rig.canvas.fire('pointerdown', { button: 0, buttons: 1, pointerId: 1, target: rig.canvas, ...at(2, 2) });
      p89Walk(rig, 2.5, 4.5, 2.5, { pointerId: 1, buttons: 1 });
      expect(rig.overlay.beltPreview.on, `${shape}: NON-VACUITY: the path is previewed`).toBe(true);
      const rings = rig.overlay.dockTargetCalls.length;
      if (shape === 'a right pointerdown') {
        rig.canvas.fire('pointerdown', { button: 2, buttons: 3, pointerId: 1, target: rig.canvas, ...at(4, 2) });
      } else {
        rig.win.fire('pointermove', { button: 2, buttons: 3, pointerId: 1, target: rig.canvas, ...p89At(4.6, 2.5) });
      }
      expect(rig.overlay.beltPreview.on, `${shape}: the path went`).toBe(false);
      expect(rig.overlay.dockTargetCalls.length, `${shape}: the resting rings repainted`).toBeGreaterThan(rings);
      expect(rig.armedCalls.at(-1), `${shape}: the Belt tool is still armed`).toEqual({ kind: 'belt' });
      expect(rig.panState.enabled, `${shape}: pan stays the armed tool's (off)`).toBe(false);
      p89Walk(rig, 4.6, 5.5, 2.5, { pointerId: 1, buttons: 1 });
      rig.win.fire('pointerup', { button: 0, buttons: 0, pointerId: 1, target: rig.canvas, ...at(5, 2) });
      expect(rig.sent, `${shape}: the release after it sends nothing`).toHaveLength(0);
      expect(rig.overlay.rejectFlashCalls, `${shape}: and flashes nothing`).toHaveLength(0);
    }
  });

  it('a_right_press_with_no_path_disarms', () => {
    // IX-08 kept: with no path in progress the right button puts the tool away on the press, so
    // the context menu that follows can never open over an armed tool.
    rig = setupRig();
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 2, target: rig.canvas, ...at(5, 5) });
    expect(rig.armedCalls.at(-1), 'the tool is put away').toBeNull();
    expect(rig.panState.enabled, 'pan restored').toBe(true);
    expect(rig.sent).toHaveLength(0);
  });

  it('a_chorded_middle_press_neither_extends_nor_commits', () => {
    // Research Pitfall 7: a middle press during a left drag arrives as a move whose `buttons`
    // gains the middle bit. Cells the hand crosses under it never enter the path, a middle release
    // commits nothing, and the left release afterwards sends the path drawn before the chord.
    rig = setupRig();
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, buttons: 1, pointerId: 1, target: rig.canvas, ...at(2, 2) });
    p89Walk(rig, 2.5, 3.5, 2.5, { pointerId: 1, buttons: 1 });
    expect(p89Shown(rig), 'NON-VACUITY: two cells drawn').toBe('[[2,2],[3,2]]');
    p89Walk(rig, 3.5, 5.5, 2.5, { pointerId: 1, buttons: 5 });
    expect(p89Shown(rig), 'the chorded samples added no cell').toBe('[[2,2],[3,2]]');
    rig.win.fire('pointerup', { button: 1, buttons: 1, pointerId: 1, target: rig.canvas, ...at(5, 2) });
    expect(rig.sent, 'a middle release commits nothing').toHaveLength(0);
    expect(rig.overlay.beltPreview.on, 'and the path is still there').toBe(true);
    p89Walk(rig, 5.5, 6.5, 2.5, { pointerId: 1, buttons: 1 });
    rig.win.fire('pointerup', { button: 0, buttons: 0, pointerId: 1, target: rig.canvas, ...at(6, 2) });
    expect(rig.sent.map((f) => [...f]), 'ONE DrawBelt, without the cells crossed under the chord').toEqual([
      p89DrawBelt([
        [2, 2],
        [3, 2],
      ]),
    ]);
    // Research A6: the LEFT released while the middle is still held (`buttons` 4) is a lost release.
    rig.canvas.fire('pointerdown', { button: 0, buttons: 1, pointerId: 1, target: rig.canvas, ...at(2, 6) });
    p89Walk(rig, 2.5, 3.5, 6.5, { pointerId: 1, buttons: 1 });
    rig.win.fire('pointermove', { pointerId: 1, buttons: 5, target: rig.canvas, ...p89At(3.6, 6.5) });
    rig.win.fire('pointermove', { pointerId: 1, buttons: 4, target: rig.canvas, ...p89At(3.7, 6.5) });
    expect(rig.overlay.beltPreview.on, 'the left let go under the middle: the path went').toBe(false);
    rig.win.fire('pointerup', { button: 1, buttons: 0, pointerId: 1, target: rig.canvas, ...at(3, 6) });
    expect(rig.sent, 'the middle release afterwards sends nothing').toHaveLength(1);
    expect(rig.armedCalls.at(-1), 'the tool is still armed').toEqual({ kind: 'belt' });
  });

  it('a_second_escape_disarms', () => {
    // W247's second half on its own: the first Escape takes the path, the tool stays; the second
    // puts the tool away and gives the camera its pan back.
    rig = setupRig();
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(2, 2) });
    p89Walk(rig, 2.5, 4.5, 2.5);
    rig.win.fire('keydown', { key: 'Escape', preventDefault: () => {} });
    expect(rig.armedCalls.at(-1), 'the first Escape keeps the tool').toEqual({ kind: 'belt' });
    expect(rig.panState.enabled, 'with the tool armed the camera pan stays off').toBe(false);
    rig.win.fire('keydown', { key: 'Escape', preventDefault: () => {} });
    expect(rig.armedCalls.at(-1), 'the second Escape puts it away').toBeNull();
    expect(rig.panState.enabled, 'and pan is back').toBe(true);
    expect(rig.sent).toHaveLength(0);
  });

  it('a_swap_mid_draw_drops_the_path', () => {
    // A swap's keyframe (New, Open, an example, a Load) is a different board: unlike an Undo's
    // keyframe it ends the path, nothing sent, and the tool stays armed.
    rig = setupRig();
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(2, 2) });
    p89Walk(rig, 2.5, 4.5, 2.5);
    rig.swap();
    rig.clearSel();
    expect(rig.overlay.beltPreview.on, 'the swap took the path').toBe(false);
    p89Walk(rig, 4.5, 5.5, 2.5);
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(5, 2) });
    expect(rig.sent, 'the release on the new board sends nothing').toHaveLength(0);
    expect(rig.armedCalls.at(-1), 'the tool is still armed').toEqual({ kind: 'belt' });
  });

  it('arming_another_tool_mid_draw_ends_the_path', () => {
    // A tool switch mid-gesture (the 89-06 carry-over): arming a machine from the keyboard while a
    // belt path is held takes the path's preview and ring down with the Belt tool.
    rig = setupRig();
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(2, 2) });
    p89Walk(rig, 2.5, 4.5, 2.5);
    expect(rig.overlay.beltPreview.on, 'NON-VACUITY: the path is previewed').toBe(true);
    rig.begin(machine_kind.SOURCE);
    expect(rig.overlay.beltPreview.on, 'the machine arm took the path preview down').toBe(false);
    expect(rig.armedCalls.at(-1), 'the machine is armed').toEqual({ kind: 'machine', machineKind: machine_kind.SOURCE });
  });

  it(
    'a_path_past_the_grid_edge_previews_red',
    () => {
      // W251 (D-12): the preview's legality matches the host's. A path whose last tile is at x 513,
      // past GRID_MAX (512, inclusive), previews red, as the host refuses it OutOfBounds.
      rig = setupRig();
      rig.armBelt();
      rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(510, 0) });
      p89Walk(rig, 510.5, 513.5, 0.5);
      const last = rig.overlay.beltCalls.at(-1);
      const cells = (last?.tiles ?? []).map((t) => [t.cell_x, t.cell_y]);
      console.log(`P89-W251 last_preview_valid=${String(last?.valid)} cells=${JSON.stringify(cells)}`);
      expect(cells.at(-1), 'PRECONDITION: the path reached x 513').toEqual([513, 0]);
      expect(last?.valid, 'a tile past the grid edge previews red').toBe(false);
    },
  );

  it(
    'a_drag_across_a_machine_sends_its_draw_belt',
    () => {
      // FAIL-02 (D-13): every non-empty release is sent, legal or not, as Place already is. A drag
      // across a machine at (3,2) sends its DrawBelt (the host answers FootprintCollision in words),
      // and the one flash lands on the first crossed machine cell.
      rig = setupRig(node({ id: 9, cell_x: 3, cell_y: 2 }));
      rig.armBelt();
      rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(2, 2) });
      p89Walk(rig, 2.5, 4.5, 2.5);
      rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(4, 2) });
      const flashes = rig.overlay.rejectFlashCalls.map((c) => c.cell);
      console.log(`P89-FAIL-02-overlap sent=${JSON.stringify(rig.sent.map((f) => [...f]))} flashes=${JSON.stringify(flashes)}`);
      expect(rig.sent.map((f) => [...f]), 'ONE DrawBelt with the drawn cells').toEqual([
        p89DrawBelt([
          [2, 2],
          [3, 2],
          [4, 2],
        ]),
      ]);
      expect(flashes, 'ONE flash, on the first crossed machine cell').toEqual([{ cx: 3, cy: 2 }]);
    },
  );
});

// REND-03 delete guard: a Delete on a machine carrying in-flight items must
// intercept (defer to the UI guard, emit NOTHING); a Delete on an empty machine
// emits exactly one Delete; commitDelete is the single emit path the dialog uses.
describe('Delete intercept + commitDelete (REND-03)', () => {
  /**
   * Minimal BeltView with `items` of length `n`, docked to node `dockNode` via a
   * Head dock (the host-authoritative link-graph dock the frontend now reads
   * instead of an endpoint-cell coincidence).
   */
  const beltWithItems = (
    id: number,
    n: number,
    dockNode: number,
  ): BeltView => ({
    id,
    latency: 1,
    fill: 0,
    items: Array.from({ length: n }, () => ({ arrival_tick: 0, tag: 0 })),
    tiles: [],
    docks: [{ end: 'Head', node: dockNode, port: 0 }],
    // SLOT-03: the belt's own advance interval, appended LAST on the wire after
    // `docks`. 1 is the pre-change IDENTITY (the sim advances on every tick), so every
    // expectation in this file means what it meant before the field existed.
    ticks_per_slot: 1,
  });

  /** Select a node at its cell centre (press-then-release, no drag). */
  const select = (r: Rig, cx: number, cy: number): void => {
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...at(cx, cy) });
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...at(cx, cy) });
  };

  it('selecting an empty machine + Delete emits exactly one Delete (no guard)', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    select(rig, 2, 2);
    expect(rig.overlay.selections).toEqual([7]);

    rig.win.fire('keydown', { key: 'Delete', preventDefault: () => {} });

    expect(rig.deleteWithItems).toHaveLength(0); // no guard
    expect(rig.sent).toHaveLength(1);
    // Delete is disc 1 after the 17-02 Wire removal renumber (was 2).
    expect(rig.sent[0][0]).toBe(1); // Delete discriminant
    expect(rig.sent[0][rig.sent[0].length - 1]).toBe(7); // node = 7
  });

  it('selecting an item-carrying machine + Delete defers to the guard and emits NOTHING', () => {
    // A machine at (2,2); a belt whose Head dock names node 7 carries 2 items.
    // The host's link-graph dock (`belt.docks[].node`) is the authoritative
    // "this belt is docked to node 7" signal — WR-02, exact handle match.
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    rig.scene.belts.set(3, beltWithItems(3, 2, 7));
    select(rig, 2, 2);

    rig.win.fire('keydown', { key: 'Delete', preventDefault: () => {} });

    expect(rig.sent).toHaveLength(0); // intercepted: no command yet
    expect(rig.deleteWithItems).toHaveLength(1);
    expect(rig.deleteWithItems[0]).toEqual({
      handle: 7,
      count: 2,
      kind: 'machine',
      beltIds: [3],
    });
  });

  it('a belt not docked to the machine is not counted (plain Delete)', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    // Belt docks to a DIFFERENT node (99) — its docks never name node 7, so it
    // is not counted against node 7's in-flight drain.
    rig.scene.belts.set(3, beltWithItems(3, 5, 99));
    select(rig, 2, 2);

    rig.win.fire('keydown', { key: 'Delete', preventDefault: () => {} });

    expect(rig.deleteWithItems).toHaveLength(0);
    expect(rig.sent).toHaveLength(1);
    expect(rig.sent[0][0]).toBe(1); // Delete discriminant (17-02 renumber)
  });

  it('commitDelete(handle) emits exactly one Delete (disc 1) for that handle', () => {
    rig = setupRig(node({ id: 9, cell_x: 4, cell_y: 4 }));
    rig.commit(9);
    expect(rig.sent).toHaveLength(1);
    expect(rig.sent[0][0]).toBe(1); // Delete discriminant (17-02 renumber)
    expect(rig.sent[0][rig.sent[0].length - 1]).toBe(9);
  });

  // ---------------------------------------------------------------------------
  // Phase 89 red-first probes (plan 89-01, D-01, D-16). Each was gated and seen red at
  // PHASE89_START, and the plan that fixed it turned it on: that plan removed the gate and the
  // red-first title suffix and changed nothing else, so the test that is green is the test that
  // was seen red. Since plan 89-09 none is gated. Each prints its
  // measured facts on `P89-` lines before it asserts. Every drag below moves in sub-cell
  // samples, never one clean cell per event.
  // ---------------------------------------------------------------------------

  it(
    'delete_on_a_selected_belt_sends_one_delete',
    () => {
      // BELT-02 (D-07): a belt with no items, selected by a click on its middle tile, is deleted by
      // the Delete key: exactly ONE Delete naming the belt, and no guard (nothing is on it).
      rig = setupRigWith({ cellsFromWorld: true });
      const r = route([
        [2, 3],
        [3, 3],
        [4, 3],
      ]);
      if (!r.ok) {
        throw new Error('fixture path must route');
      }
      rig.scene.belts.set(21, { id: 21, latency: 3, fill: 0, items: [], tiles: r.tiles, docks: [], ticks_per_slot: 1 });
      const mid = { clientX: 3 * CELL + CELL / 2, clientY: 3 * CELL + CELL / 2 };
      rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...mid });
      rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...mid });
      expect(rig.onSelectBeltCalls.at(-1), 'PRECONDITION: the click selected the belt').toBe(21);
      rig.sent.length = 0;
      rig.win.fire('keydown', { key: 'Delete', preventDefault: () => {} });
      console.log(`P89-BELT-02 sent=${JSON.stringify(rig.sent.map((f) => [...f]))} guard=${JSON.stringify(rig.deleteWithItems)}`);
      expect(rig.sent.map((f) => [...f]), 'ONE Delete naming the selected belt').toEqual([
        [...encodeGridCommand({ kind: 'Delete', node: 21 })],
      ]);
      expect(rig.deleteWithItems, 'no guard: the belt carries no items').toEqual([]);
    },
  );
  // Phase 89, plan 89-06 (D-07, BELT-02, UI-SPEC section 2): the selected belt's guarded delete,
  // beside the probe above. Belt 21 on (2,3)..(4,3), selected by a click on its middle tile.
  const p89Belt = (items: number): BeltView => {
    const r = route([
      [2, 3],
      [3, 3],
      [4, 3],
    ]);
    if (!r.ok) {
      throw new Error('fixture path must route');
    }
    return {
      id: 21,
      latency: 3,
      fill: 0,
      items: Array.from({ length: items }, () => ({ arrival_tick: 0, tag: 0 })),
      tiles: r.tiles,
      docks: [],
      ticks_per_slot: 1,
    };
  };
  const p89SelectBelt = (r: Rig): void => {
    const mid = { clientX: 3 * CELL + CELL / 2, clientY: 3 * CELL + CELL / 2 };
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...mid });
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...mid });
    expect(r.onSelectBeltCalls.at(-1), 'PRECONDITION: the click selected the belt').toBe(21);
    r.sent.length = 0;
  };

  it('a_belt_carrying_items_opens_the_guard_and_sends_nothing', () => {
    // T-89-16: a belt with items on it opens the shipped guard with kind `belt`, its own count and
    // itself as the one belt to drain, and sends nothing until a choice.
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, p89Belt(3));
    p89SelectBelt(rig);
    rig.win.fire('keydown', { key: 'Delete', preventDefault: () => {} });
    expect(rig.deleteWithItems, "the guard, with the belt's own count").toEqual([
      { handle: 21, count: 3, kind: 'belt', beltIds: [21] },
    ]);
    expect(rig.sent, 'nothing sent before a choice').toHaveLength(0);
  });

  it('backspace_in_the_pace_field_sends_nothing', () => {
    // UI-SPEC 2.2: Backspace (or Delete) with the pace field focused is the field's own edit. The
    // same key with focus on the board deletes the belt (NON-VACUITY, the last step).
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, p89Belt(0));
    p89SelectBelt(rig);
    (globalThis as unknown as { document: { activeElement: unknown } }).document = {
      activeElement: { tagName: 'INPUT', isContentEditable: false },
    };
    try {
      rig.win.fire('keydown', { key: 'Backspace', preventDefault: () => {} });
      rig.win.fire('keydown', { key: 'Delete', preventDefault: () => {} });
      expect(rig.sent, 'a key in the pace field sends nothing').toHaveLength(0);
      expect(rig.deleteWithItems, 'and opens no guard').toEqual([]);
    } finally {
      delete (globalThis as unknown as { document?: unknown }).document;
    }
    rig.win.fire('keydown', { key: 'Backspace', preventDefault: () => {} });
    expect(rig.sent.map((f) => [...f]), 'NON-VACUITY: Backspace on the board deletes the belt').toEqual([
      [...encodeGridCommand({ kind: 'Delete', node: 21 })],
    ]);
  });

  it('a_deleted_belt_clears_its_selection', () => {
    // UI-SPEC 2.3: after the Delete the belt channel reads null, the end handles are cleared, and
    // a second Delete has nothing to delete.
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, p89Belt(0));
    p89SelectBelt(rig);
    const handles = rig.overlay.beltHandlesCleared.count;
    rig.win.fire('keydown', { key: 'Delete', preventDefault: () => {} });
    expect(rig.sent).toHaveLength(1);
    expect(rig.onSelectBeltCalls.at(-1), 'the belt selection cleared').toBeNull();
    expect(rig.overlay.beltHandlesCleared.count, 'the belt handles cleared').toBeGreaterThan(handles);
    rig.win.fire('keydown', { key: 'Delete', preventDefault: () => {} });
    expect(rig.sent, 'a second Delete sends nothing: nothing is selected').toHaveLength(1);
  });

  it('r_on_a_selected_belt_sends_nothing', () => {
    // UI-SPEC A19: `r` stays a no-op on a selected belt.
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, p89Belt(0));
    p89SelectBelt(rig);
    rig.win.fire('keydown', { key: 'r', preventDefault: () => {} });
    rig.win.fire('keydown', { key: 'R', shiftKey: true, preventDefault: () => {} });
    expect(rig.sent, 'no Rotate for a belt').toHaveLength(0);
  });
});

// CTRL-01: belt selection + endpoint-handle dock drag. The identity cam shim
// means screen px == world px and scale 1 (nubHitRadiusWorld = 12). Fixture: a
// FACTORY-shape 3x3 node with explicit ports [In side W, Out side E, Fault
// side S] and DrawBelt-shaped belts whose end tiles sit adjacent-facing those
// ports. Dock byte layout: [disc=4, belt, end (Head=0/Tail=1), node, port].
describe('Belt selection + dock drag (CTRL-01)', () => {
  /** The 3x3 FACTORY fixture: In on the W edge, Out on E, Fault on S. */
  const factory = (): NodeView =>
    node({
      id: 5,
      kind: machine_kind.FACTORY,
      cell_x: 4,
      cell_y: 4,
      w: 3,
      h: 3,
      ports: [
        { index: 0, cell_x: 4, cell_y: 5, side: 3, role: 0, medium: 0 }, // In, faces W
        { index: 1, cell_x: 6, cell_y: 5, side: 1, role: 1, medium: 0 }, // Out, faces E
        { index: 2, cell_x: 5, cell_y: 6, side: 2, role: 2, medium: 0 }, // Fault, faces S
      ],
    });

  const tile = (cx: number, cy: number): TileView => ({
    cell_x: cx,
    cell_y: cy,
    kind: { Straight: { axis: 0 } },
  });

  /** An undocked DrawBelt-shaped belt through `cells` (Tail=first, Head=last). */
  const belt = (id: number, cells: Array<[number, number]>): BeltView => ({
    id,
    latency: 1,
    fill: 0,
    items: [],
    tiles: cells.map(([x, y]) => tile(x, y)),
    docks: [],
    // SLOT-03: the belt's own advance interval, appended LAST on the wire after
    // `docks`. 1 is the pre-change IDENTITY (the sim advances on every tick), so every
    // expectation in this file means what it meant before the field existed.
    ticks_per_slot: 1,
  });

  /**
   * The Tail-side fixture belt (id 3): tiles (7,5)->(9,5). Its Tail tile (7,5)
   * sits adjacent-facing the Out port at (6,5) side E (outward (-1,0) ==
   * unitDelta(opposite(E))), so a Tail dock onto the Out nub accepts.
   */
  const tailBelt = (): BeltView =>
    belt(3, [
      [7, 5],
      [8, 5],
      [9, 5],
    ]);

  /**
   * The Head-side fixture belt (id 4): tiles (1,5)->(3,5). Its Head tile (3,5)
   * sits adjacent-facing the In port at (4,5) side W (outward (1,0) ==
   * unitDelta(opposite(W))), so a Head dock onto the In nub accepts.
   */
  const headBelt = (): BeltView =>
    belt(4, [
      [1, 5],
      [2, 5],
      [3, 5],
    ]);

  /** Select a belt: press-then-release on one of its tiles. */
  const selectBelt = (r: Rig, cx: number, cy: number): void => {
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...at(cx, cy) });
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...at(cx, cy) });
  };

  /** Raw client-px event coords (screen px == world px under the identity cam). */
  const atPx = (x: number, y: number) => ({ clientX: x, clientY: y });

  /** Drag: down at `from`, move to `to`, release at `to` (world/client px). */
  const dragHandle = (r: Rig, from: Pt, to: Pt): void => {
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...atPx(from.x, from.y) });
    r.win.fire('pointermove', { target: r.canvas, ...atPx(to.x, to.y) });
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...atPx(to.x, to.y) });
  };

  // Fixture nub world points (the shared ports.ts anchor math).
  const outNub = nubAnchor(6, 5, 1); // (224.5, 176)
  const inNub = nubAnchor(4, 5, 3); // (127.5, 176)

  // =============================================================================
  // BELT-01 / 68-UI-SPEC FINDING 3 - the belt channel stays SEPARATE. Until phase 89 a belt
  // got NO keyboard Delete and NO keyboard rotate. Phase 89 (D-07) supersedes FINDING 3's
  // Delete half: the Delete key on a selected belt runs the belt's OWN guarded path,
  // `requestBeltDelete`, and `r` stays a no-op (UI-SPEC A19).
  //
  // MUTATION-PROVED, as before, against the regression FINDING 3 describes: widening
  // `selectedNode()` to return the belt handle sends the Delete through the MACHINE path,
  // which counts items on belts docked to a node with that handle (none), so it sends a
  // Delete over a belt carrying items with no guard. This belt carries two items, so the
  // belt path opens the guard and sends nothing, and that widening reddens this case.
  // =============================================================================

  it('BELT-01 V3 (phase 89, D-07): a selected belt carrying items is guarded by the Delete key, and r sends nothing', () => {
    rig = setupRig(factory());
    rig.scene.belts.set(3, { ...tailBelt(), items: [{ arrival_tick: 0, tag: 0 }, { arrival_tick: 0, tag: 0 }] });
    selectBelt(rig, 8, 5);
    // The belt REALLY IS selected - without this the case would pass vacuously
    // over a press that selected nothing at all.
    expect(rig.onSelectBeltCalls).toEqual([3]);

    rig.win.fire('keydown', { key: 'r', shiftKey: false, preventDefault: () => {} });
    rig.win.fire('keydown', { key: 'r', shiftKey: true, preventDefault: () => {} });
    expect(rig.sent, 'r on a belt selection puts NO command on the wire').toHaveLength(0);

    rig.win.fire('keydown', { key: 'Delete', preventDefault: () => {} });
    // ZERO FRAMES and the BELT guard. Not "the belt still exists" - a Delete that emitted a
    // frame the host then refused would satisfy that and would still be the regression.
    expect(rig.sent, 'the guard holds the Delete: nothing on the wire').toHaveLength(0);
    expect(rig.deleteWithItems, "the belt's own guard, with its own count").toEqual([
      { handle: 3, count: 2, kind: 'belt', beltIds: [3] },
    ]);
  });

  it('BELT-01: a selected belt still reads as null to selectedId(), exactly as at HEAD', () => {
    rig = setupRig(factory());
    rig.scene.belts.set(3, tailBelt());
    selectBelt(rig, 8, 5);
    expect(rig.selectedId()).toBeNull();
    expect(rig.onSelectCalls).toEqual([null]);
  });

  it('BELT-01: every selection-clearing site drives onSelectBelt(null) too', () => {
    // THE SIX SITES, NAMED BY LINE so a later reader can check this list against
    // `grep -n "deps.onSelect?.(" frontend/src/input/gestures.ts` rather than
    // trusting it. The seventh site is the belt arm itself (`:2540`), which is the
    // ONE row that fires a non-null belt handle and is covered by the two cases
    // above.
    //
    // Wiring only the belt arm is not a cosmetic gap: it leaves five paths that
    // clear the NODE selection and leave a stale BELT selection behind, so App's
    // belt ConfigPanel stays mounted over the whole right band and intercepts
    // pointer events for every later click. That is a live-suite red, not a
    // theoretical one - it was measured on this plan's own first commit.
    const sites: Array<{ line: string; what: string; run: (r: Rig) => void }> = [
      {
        line: 'gestures.ts:1854',
        what: 'a stranded-ring press (starts a dock drag, opens no panel)',
        run: (r) => {
          r.setStrandedRings([{ beltId: 3, end: 'Tail', pt: { x: 7 * CELL + CELL / 2, y: 5 * CELL + CELL / 2 } }]);
          r.canvas.fire('pointerdown', {
            button: 0,
            target: r.canvas,
            clientX: 7 * CELL + CELL / 2,
            clientY: 5 * CELL + CELL / 2,
          });
        },
      },
      {
        line: 'gestures.ts:1926',
        what: 'a bare press on empty floor',
        run: (r) => {
          r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...at(20, 20) });
        },
      },
      {
        line: 'gestures.ts:2529',
        what: 'selecting a NODE instead',
        run: (r) => {
          r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...at(5, 5) });
          r.win.fire('pointerup', { button: 0, target: r.canvas, ...at(5, 5) });
        },
      },
      {
        line: 'gestures.ts:2555',
        what: 'commitDelete (a logged Delete)',
        run: (r) => r.commit(5),
      },
      {
        line: 'gestures.ts:2655',
        what: 'clearSelection (the keyframe teardown App calls)',
        run: (r) => r.clearSel(),
      },
      {
        line: 'gestures.ts:2803',
        what: 'Escape (IX-07)',
        run: (r) => r.win.fire('keydown', { key: 'Escape', preventDefault: () => {} }),
      },
    ];

    for (const site of sites) {
      rig?.destroy();
      rig = setupRig(factory());
      rig.scene.belts.set(3, tailBelt());
      selectBelt(rig, 8, 5);
      expect(rig.onSelectBeltCalls, `${site.line} setup: the belt is selected`).toEqual([3]);

      site.run(rig);

      expect(
        rig.onSelectBeltCalls.at(-1),
        `${site.line} (${site.what}) must clear the BELT channel too, or ` +
          'selectedNode and selectedBelt are both non-null',
      ).toBeNull();
    }
  });

  it('BELT-01: selecting a node after a belt clears the belt in the same gesture', () => {
    rig = setupRig(factory());
    rig.scene.belts.set(3, tailBelt());
    selectBelt(rig, 8, 5);
    expect(rig.onSelectBeltCalls).toEqual([3]);

    // Press-release on the factory body at (5,5).
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(5, 5) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(5, 5) });

    expect(rig.onSelectCalls.at(-1)).toBe(5);
    expect(rig.onSelectBeltCalls.at(-1)).toBeNull();
    // The two channels are never both non-null - the property App must NOT
    // re-derive, because it is a construction property of this layer.
    expect(rig.selectedId()).toBe(5);
  });

  it('BELT-01: the DeleteControl mount gate sees null for a belt selection', () => {
    // App mounts DeleteControl on `selectedNode !== null && armed === null`, and
    // `selectedNode` is fed by `onSelect`. Asserted on the GATE'S INPUT rather than
    // on a rendered tree, because this rig cannot mount App - which is what the
    // 68-UI-SPEC verification row allows for.
    rig = setupRig(factory());
    rig.scene.belts.set(3, tailBelt());
    selectBelt(rig, 8, 5);
    expect(rig.onSelectCalls.at(-1), 'the node channel stays null for a belt').toBeNull();
    expect(rig.onSelectBeltCalls.at(-1)).toBe(3);
  });

  it('press+release on a belt tile selects the belt: handles shown once, selectedId null', () => {
    rig = setupRig(factory());
    rig.scene.belts.set(3, tailBelt());
    selectBelt(rig, 8, 5);

    const expected = beltHandlePoints(rig.scene.nodes, rig.scene.belts, rig.scene.belts.get(3)!);
    expect(rig.overlay.beltHandleCalls).toEqual([expected]);
    // Undocked ends anchor at the end tile centers.
    expect(expected).toEqual({
      head: { x: 9 * CELL + CELL / 2, y: 5 * CELL + CELL / 2 },
      tail: { x: 7 * CELL + CELL / 2, y: 5 * CELL + CELL / 2 },
    });
    // External contract preserved: a selected BELT reads as null (App's
    // delete-guard/chrome flow stays node-scoped); no box outline shown.
    expect(rig.selectedId()).toBeNull();
    expect(rig.overlay.selections).toEqual([]);
    expect(rig.sent).toHaveLength(0); // selection emits nothing
  });

  it('hovering a selected belt endpoint handle shows the r=8 ring + cursor pointer; leaving clears both', () => {
    rig = setupRig(factory());
    rig.scene.belts.set(3, tailBelt());
    selectBelt(rig, 8, 5);
    const tailPt = { x: 7 * CELL + CELL / 2, y: 5 * CELL + CELL / 2 };

    // Idle move within the 12px handle hit target → hover ring + 'pointer'.
    rig.win.fire('pointermove', { target: rig.canvas, ...atPx(tailPt.x + 3, tailPt.y) });
    expect(rig.overlay.handleRingCalls).toEqual([tailPt]);
    expect(rig.cursor()).toBe('pointer');

    // Leaving the hit target clears the ring and restores the cursor.
    rig.win.fire('pointermove', { target: rig.canvas, ...atPx(500, 500) });
    expect(rig.overlay.handleRingCleared.count).toBeGreaterThan(0);
    expect(rig.cursor()).toBe('');
  });

  it('dragging the TAIL handle onto the Out nub emits exactly ONE byte-exact Dock (armed ring shown)', () => {
    rig = setupRig(factory());
    rig.scene.belts.set(3, tailBelt());
    selectBelt(rig, 8, 5);

    dragHandle(rig, { x: 7 * CELL + CELL / 2, y: 5 * CELL + CELL / 2 }, outNub);

    expect(rig.sent).toHaveLength(1);
    expect(rig.sent[0][0]).toBe(4); // Dock discriminant
    // Byte-equality against the REAL encoder: belt 3, Tail=1, node 5, port 1
    // (the SPATIAL CATALOG index verbatim — the host owns keyspace translation).
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 3, end: 'Tail', node: 5, port: 1 }),
    ]);
    // The armed (will-commit) ring was shown on the accepting nub.
    expect(rig.overlay.nubRingCalls).toContainEqual({ pt: outNub, armed: true });
    // Drag ended cleanly: pan restored, cursor released, belt still selected
    // (handles re-shown after the emit).
    expect(rig.panState.enabled).toBe(true);
    expect(rig.cursor()).toBe('');
    expect(rig.overlay.beltHandleCalls.length).toBe(2); // select + post-release
  });

  // Phase 64 (D-07): this case asserted `toHaveLength(0)` under the name
  // "emits NOTHING and snaps back". The no-emit was never a guarantee the user
  // wanted — it was the client deciding not to ask, which cost a wrong-role drop
  // its explanation. The Dock IS emitted now and the host answers `InvalidDock`.
  // What the test still protects is the PREDICTION: the ring must stay passive,
  // because a build-coloured ring over a port that cannot take the end would be
  // the affordance lying.
  it('dragging the TAIL handle onto the In nub (wrong role) emits ONE Dock the host refuses, ring passive', () => {
    rig = setupRig(factory());
    rig.scene.belts.set(3, tailBelt());
    selectBelt(rig, 8, 5);

    dragHandle(rig, { x: 7 * CELL + CELL / 2, y: 5 * CELL + CELL / 2 }, inNub);

    // The gesture is ASKED, not swallowed: exactly one Dock addressing the In
    // port the user actually pointed at.
    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 3, end: 'Tail', node: 5, port: 0 }),
    ]);
    // Only a PASSIVE ring was recorded — never armed:true. The predicate still
    // rejects In for a Tail end; it now ranks and colours rather than gates.
    expect(rig.overlay.nubRingCalls.some((c) => c.armed)).toBe(false);
    expect(rig.overlay.nubRingCalls).toContainEqual({ pt: inNub, armed: false });
    // Snap-back is unchanged: the dragged handle was cleared and the handles
    // re-shown. Nothing is drawn optimistically; the echo is still the only
    // thing that moves the belt.
    expect(rig.overlay.draggedHandleCleared.count).toBeGreaterThan(0);
    expect(rig.overlay.beltHandleCalls.length).toBe(2);
  });

  it('a drag released on empty floor emits NOTHING and re-shows the handles', () => {
    rig = setupRig(factory());
    rig.scene.belts.set(3, tailBelt());
    selectBelt(rig, 8, 5);

    dragHandle(rig, { x: 7 * CELL + CELL / 2, y: 5 * CELL + CELL / 2 }, { x: 600, y: 100 });

    expect(rig.sent).toHaveLength(0);
    expect(rig.overlay.nubRingCalls.some((c) => c.armed)).toBe(false);
    expect(rig.overlay.beltHandleCalls.length).toBe(2); // select + snap-back
  });

  // PORT-08 (T-36-03): a belt is a Mechanical carrier, so docking it onto an
  // ELECTRICAL (wire) Out port is a MediumMismatch. Geometry (role/adjacency/
  // facing) all pass — only the medium is wrong. Until Phase 64 the client
  // answered that itself: it emitted nothing and flashed, which meant GUESSING
  // the reason (drift C — a wrong-medium-AND-wrong-adjacency drop got silence
  // instead). Now the Dock is emitted, the host answers `MediumMismatch` in
  // words, and the flash says WHERE only.
  const electricalOutFactory = (): NodeView =>
    node({
      id: 5,
      kind: machine_kind.FACTORY,
      cell_x: 4,
      cell_y: 4,
      w: 3,
      h: 3,
      ports: [
        { index: 0, cell_x: 4, cell_y: 5, side: 3, role: 0, medium: MEDIUM_MECHANICAL }, // In, W
        { index: 1, cell_x: 6, cell_y: 5, side: 1, role: 1, medium: MEDIUM_ELECTRICAL }, // Out, E (wire)
        { index: 2, cell_x: 5, cell_y: 6, side: 2, role: 2, medium: MEDIUM_MECHANICAL }, // Fault, S
      ],
    });

  it('dragging a belt onto an ELECTRICAL Out port emits ONE Dock the host refuses as MediumMismatch (PORT-08)', () => {
    rig = setupRig(electricalOutFactory());
    rig.scene.belts.set(3, tailBelt());
    selectBelt(rig, 8, 5);

    dragHandle(rig, { x: 7 * CELL + CELL / 2, y: 5 * CELL + CELL / 2 }, outNub);

    // The wire port the user pointed at IS addressed, so the host gets to name
    // the reason instead of the client inventing one.
    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 3, end: 'Tail', node: 5, port: 1 }),
    ]);
    // The ring stayed PASSIVE (the medium gate fails acceptsDock — never
    // armed:true). The prediction is retained in full; only the block is gone.
    expect(rig.overlay.nubRingCalls.some((c) => c.armed)).toBe(false);
    expect(rig.overlay.nubRingCalls).toContainEqual({ pt: outNub, armed: false });
    // No client-side flash on this path any more. The flash it used to fire was
    // the client asserting a CAUSE (D-10); the drag-dock release now emits and
    // says nothing until the host's verdict arrives.
    expect(rig.overlay.rejectFlashCalls).toHaveLength(0);
  });

  it('a belt onto a MECHANICAL Out port still docks (the medium gate is not over-broad)', () => {
    rig = setupRig(factory()); // factory()'s Out port is Mechanical
    rig.scene.belts.set(3, tailBelt());
    selectBelt(rig, 8, 5);

    const flashesBefore = rig.overlay.rejectFlashCalls.length;
    dragHandle(rig, { x: 7 * CELL + CELL / 2, y: 5 * CELL + CELL / 2 }, outNub);

    expect(rig.sent).toHaveLength(1);
    expect(rig.sent[0][0]).toBe(4); // Dock discriminant — the compatible dock commits
    // No spurious medium reject flash on a legal dock.
    expect(rig.overlay.rejectFlashCalls.length).toBe(flashesBefore);
  });

  // ---- the ranker (drift A, Phase 64 D-07) --------------------------------
  //
  // Two nubs inside the SAME zoom-compensated hit radius, where the NEARER one
  // cannot take the end. Until Phase 64 the drag kept only the single closest
  // nub, tested it, and stopped: the legal port 1px further away was
  // unreachable, and the gesture died with a passive ring and no command. That
  // is drift A, and it is a case where the client refused something the host
  // would have ACCEPTED — the worst of the six, because no message can rescue a
  // gesture that was never sent.
  //
  // The geometry, spelled out because the numbers look arbitrary otherwise (CELL
  // 32, INSET 2, NUB_PUSH 2.5, camera scale 1 so nubHitRadiusWorld = 12):
  //   - the factory's Out nub at cell (6,5) side E anchors at (224.5, 176) and
  //     ACCEPTS a Tail dock from tailBelt (its Tail tile (7,5) is adjacent and
  //     facing);
  //   - a decoy In nub at cell (7,6) side N anchors at (240, 191.5) and can
  //     never take a Tail end (wrong role);
  //   - the release point (232.6, 184.1) sits 11.46 world px from the accepting
  //     nub and 10.47 from the decoy, so BOTH are reachable and the decoy is
  //     nearer. Distinct nub anchors are ~22 world px apart at zoom 1, so a
  //     two-nub radius is inherently a near-tie; that is why this bug was quiet.
  /** A 1x1 decoy node whose only port is an In nub at (7,6) facing N. */
  const decoyIn = (): NodeView =>
    node({
      id: 7,
      kind: machine_kind.SINK,
      cell_x: 7,
      cell_y: 6,
      ports: [{ index: 0, cell_x: 7, cell_y: 6, side: 0, role: 0, medium: 0 }],
    });
  const decoyNub = nubAnchor(7, 6, 0); // (240, 191.5)
  /** Between the two nubs, nearer to the decoy. */
  const betweenNubs = { x: 232.6, y: 184.1 };

  it('two nubs in radius, the nearer refusing: the drag addresses the ACCEPTING one (drift A)', () => {
    // The premise, asserted rather than asserted-in-a-comment: both nubs are
    // inside the radius and the DECOY is the nearer of the two. Without this a
    // green test would prove nothing — an out-of-radius decoy passes trivially.
    const d = (p: Pt): number =>
      Math.hypot(p.x - betweenNubs.x, p.y - betweenNubs.y);
    expect(d(decoyNub)).toBeLessThan(d(outNub));
    expect(d(outNub)).toBeLessThan(nubHitRadiusWorld(1));

    rig = setupRig(factory(), decoyIn());
    rig.scene.belts.set(3, tailBelt());
    selectBelt(rig, 8, 5);

    dragHandle(rig, { x: 7 * CELL + CELL / 2, y: 5 * CELL + CELL / 2 }, betweenNubs);

    // The FARTHER, legal Out port is the one addressed. Against the pre-change
    // single-nearest lookup this line reads 0: the decoy won on distance, failed
    // the predicate, and the gesture was dropped.
    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 3, end: 'Tail', node: 5, port: 1 }),
    ]);
    // The ring is drawn at the chosen nub and shows ACCEPTING, so the affordance
    // names the port that is actually being addressed.
    expect(rig.overlay.nubRingCalls).toContainEqual({ pt: outNub, armed: true });
    expect(rig.overlay.nubRingCalls).not.toContainEqual({ pt: decoyNub, armed: true });
  });

  it('two nubs in radius and NEITHER accepts: the nearest is addressed, ring non-accepting', () => {
    // Same two nubs, except the Out port is now ELECTRICAL, so a Mechanical belt
    // cannot dock it either. Nothing in the radius accepts.
    rig = setupRig(electricalOutFactory(), decoyIn());
    rig.scene.belts.set(3, tailBelt());
    selectBelt(rig, 8, 5);

    dragHandle(rig, { x: 7 * CELL + CELL / 2, y: 5 * CELL + CELL / 2 }, betweenNubs);

    // The nearest nub is addressed anyway and the host refuses it with a typed
    // reason — never silence. This is the fallback half of the ranker.
    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 3, end: 'Tail', node: 7, port: 0 }),
    ]);
    // The prediction is retained in full: nothing accepted, so nothing is
    // painted as accepting.
    expect(rig.overlay.nubRingCalls.some((c) => c.armed)).toBe(false);
    expect(rig.overlay.nubRingCalls).toContainEqual({ pt: decoyNub, armed: false });
  });

  it('mid-drag clearSelection (keyframe path) kills the drag: later move/up emit nothing', () => {
    rig = setupRig(factory());
    rig.scene.belts.set(3, tailBelt());
    selectBelt(rig, 8, 5);

    // Start the drag and park it over the ACCEPTING Out nub (armed state).
    rig.canvas.fire('pointerdown', {
      button: 0,
      target: rig.canvas,
      ...atPx(7 * CELL + CELL / 2, 5 * CELL + CELL / 2),
    });
    rig.win.fire('pointermove', { target: rig.canvas, ...atPx(outNub.x, outNub.y) });
    expect(rig.overlay.nubRingCalls).toContainEqual({ pt: outNub, armed: true });

    // A full:true keyframe lands → App calls clearSelection. Everything
    // ephemeral clears: drag, handles, dragged handle, nub ring (T-21-08).
    rig.clearSel();
    expect(rig.overlay.beltHandlesCleared.count).toBeGreaterThan(0);
    expect(rig.overlay.draggedHandleCleared.count).toBeGreaterThan(0);
    expect(rig.overlay.nubRingCleared.count).toBeGreaterThan(0);
    expect(rig.panState.enabled).toBe(true);
    expect(rig.cursor()).toBe('');

    // Subsequent move/up on the dead drag emit NOTHING — a stale-handle Dock
    // against re-minted handles is unreachable.
    rig.win.fire('pointermove', { target: rig.canvas, ...atPx(outNub.x, outNub.y) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atPx(outNub.x, outNub.y) });
    expect(rig.sent).toHaveLength(0);
  });

  it('dragging the HEAD handle onto the In nub emits Dock with end disc Head=0 and port 0', () => {
    rig = setupRig(factory());
    rig.scene.belts.set(4, headBelt());
    selectBelt(rig, 2, 5);

    dragHandle(rig, { x: 3 * CELL + CELL / 2, y: 5 * CELL + CELL / 2 }, inNub);

    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 4, end: 'Head', node: 5, port: 0 }),
    ]);
    // Wire layout sanity: [disc=4, belt=4, end Head=0, node=5, port=0].
    expect([...rig.sent[0]]).toEqual([4, 4, 0, 5, 0]);
  });

  // WR-02: after a Dock echo the selected belt's end resolves to the nub
  // anchor (~15.5px from the tile center at CELL=32, beyond the 12px hit radius), so
  // the handles drawn at the pre-echo positions must be re-shown when the
  // belt is re-emitted, or the visible circle and the grab point diverge.
  it('re-shows the handles at the post-echo points when the SELECTED belt is re-emitted (WR-02)', () => {
    rig = setupRig(factory());
    rig.scene.belts.set(3, tailBelt());
    selectBelt(rig, 8, 5);
    // Selected: handles drawn once, Tail at the (undocked) end tile center.
    expect(rig.overlay.beltHandleCalls).toHaveLength(1);
    expect(rig.overlay.beltHandleCalls[0].tail).toEqual({
      x: 7 * CELL + CELL / 2,
      y: 5 * CELL + CELL / 2,
    });

    // The Dock echo lands: the belt re-emits carrying a Tail dock whose wire
    // key names the factory's Out port (Tail keyspace: nth role===Out => 0).
    rig.scene.belts.get(3)!.docks = [{ end: 'Tail', node: 5, port: 0 }];
    rig.refreshSel([], [3]);

    // The handles were re-shown at the CURRENT beltHandlePoints: the docked
    // Tail end now anchors at the Out nub, matching what hitHandle targets.
    expect(rig.overlay.beltHandleCalls).toHaveLength(2);
    expect(rig.overlay.beltHandleCalls.at(-1)!.tail).toEqual(outNub);
    expect(rig.sent).toHaveLength(0); // display-only refresh
  });

  it('a re-emit of a DIFFERENT belt leaves the drawn handles untouched (WR-02)', () => {
    rig = setupRig(factory());
    rig.scene.belts.set(3, tailBelt());
    selectBelt(rig, 8, 5);
    expect(rig.overlay.beltHandleCalls).toHaveLength(1);

    rig.refreshSel([], [99]);
    expect(rig.overlay.beltHandleCalls).toHaveLength(1); // no extra redraw
  });
});

// CTRL-02 / D-12 port-to-port draw, D-09 auto-dock, D-10 nub hover priority.
// All follow-up Docks ride the belt-echo watcher: the test emits the DrawBelt,
// INJECTS the echoed belt (tiles = the shared route() output, fresh id), then
// flushes the manually-driven rAF queue — mirroring the host echo sequencing
// (a same-tick batch can never reference a same-batch mint, Finding 4).
describe('Port-to-port draw + auto-dock + nub hover (CTRL-02 / D-09 / D-10)', () => {
  /** SOURCE-shape: 1x1 at (2,5), one Out port on the E edge (faces (3,5)). */
  const source = (): NodeView =>
    node({
      id: 1,
      kind: machine_kind.SOURCE,
      cell_x: 2,
      cell_y: 5,
      ports: [{ index: 0, cell_x: 2, cell_y: 5, side: 1, role: 1, medium: 0 }],
    });

  /** SINK-shape: 1x1 at (8,5), one In port on the W edge (faces (7,5)). */
  const sink = (): NodeView =>
    node({
      id: 2,
      kind: machine_kind.SINK,
      cell_x: 8,
      cell_y: 5,
      ports: [{ index: 0, cell_x: 8, cell_y: 5, side: 3, role: 0, medium: 0 }],
    });

  // Fixture nub world points (shared ports.ts anchor math).
  const outNub = nubAnchor(2, 5, 1); // (96.5, 176)
  const inNub = nubAnchor(8, 5, 3); // (255.5, 176)
  /**
   * A pointer event at the WORLD centre of cell (cx, cy). For the real-camera rig
   * (`setupRigWith({ cellsFromWorld: true })`), where a cell is `floor(world / CELL)`.
   */
  const atC = (cx: number, cy: number) => ({
    clientX: cx * CELL + CELL / 2,
    clientY: cy * CELL + CELL / 2,
  });
  /**
   * The Out port's DOORSTEP (3,5), at its centre: since phase 74.1 the Belt-armed press
   * target for that port. The press is resolved BY CELL, so a press anywhere inside
   * (3,5) hits it; its centre is also where the armed ring is drawn. This rig's press
   * used to be `outNub`, the edge nub, which no longer starts a belt draw.
   */
  const outDoor = { x: 3 * CELL + CELL / 2, y: 5 * CELL + CELL / 2 }; // (112, 176)

  /** Raw client-px event coords (screen px == world px under the identity cam). */
  const atPx = (x: number, y: number) => ({ clientX: x, clientY: y });

  /** The echoed belt for `cells`: tiles are the SHARED route() output. */
  const echoBelt = (id: number, cells: Array<[number, number]>): BeltView => {
    const r = route(cells);
    if (!r.ok) {
      throw new Error('fixture path must route');
    }
    // SLOT-03: the identity interval, as everywhere in this file (see beltWithItems).
    return { id, latency: 1, fill: 0, items: [], tiles: r.tiles, docks: [], ticks_per_slot: 1 };
  };

  /** The full port-to-port drag: press on the Out nub, east, release on the In nub. */
  const portToPortCells: Array<[number, number]> = [
    [3, 5],
    [4, 5],
    [5, 5],
    [6, 5],
    [7, 5],
  ];
  /**
   * NEEDS THE REAL-CAMERA RIG (74.1). Every caller builds its rig with
   * `setupRigWith({ cellsFromWorld: true }, ...)`: the press is resolved by CELL through
   * `cam.screenToCell`, so under the legacy `cell = floor(screen)` shim a world-px press
   * names a nonsense cell, starts a plain one-cell draw, and every assertion downstream
   * measures that instead of the port-to-port gesture.
   */
  const dragPortToPort = (r: Rig): void => {
    r.armBelt();
    // Press the Out port's doorstep (3,5): the draw seeds there and records the Tail dock.
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...atPx(outDoor.x, outDoor.y) });
    // Drag east cell centre by cell centre, in world px.
    for (const cx of [4, 5, 6, 7]) {
      r.win.fire('pointermove', { target: r.canvas, ...atC(cx, 5) });
    }
    // Release within the 12px hit radius of the In nub (world (255.5,176), inside (7,5)).
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...atPx(inNub.x, inNub.y) });
  };

  it('port-to-port: DrawBelt from the Out facing cell to the In facing cell, then Tail+Head Docks after the echo (byte-equal, ordered)', () => {
    // 74.1: real-camera rig, press on the Out port's DOORSTEP. Same bytes as before.
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    dragPortToPort(rig);

    // Exactly ONE DrawBelt at release: cells start at the Out port's facing
    // cell (3,5) and end at the In port's facing cell (7,5). No Dock yet —
    // the release handler never emits one (the handle does not exist).
    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({ kind: 'DrawBelt', cells: portToPortCells }),
    ]);
    // The pressed source showed the ARMED ring (build = committed source), on its
    // DOORSTEP centre since 74.1, concentric with that port's resting ring.
    expect(rig.overlay.nubRingCalls).toContainEqual({ pt: outDoor, armed: true });
    expect(rig.overlay.nubRingCalls.some((c) => c.pt.x === outNub.x)).toBe(false);

    // Host echo: a belt with EXACTLY the routed tiles under a fresh handle.
    // The host accepts the DrawBelt, minting belt 42 (plan 88-06, D-06).
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, echoBelt(42, portToPortCells));
    rig.flushRaf();

    // Exactly two more frames, Tail FIRST then Head, byte-equal via the real
    // encoder. Tail names the source Out port; Head names the sink In port.
    expect(rig.sent).toHaveLength(3);
    expect([...rig.sent[1]]).toEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Tail', node: 1, port: 0 }),
    ]);
    expect([...rig.sent[2]]).toEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Head', node: 2, port: 0 }),
    ]);
  });

  it('an over-long sample walks nothing, so the preview is not touched', () => {
    // THE BELT_WALK_MAX_CELLS CEILING PIN, RE-AUTHORED FOR THE REAL CAMERA in 74.1.
    // It used to lean on the legacy `cell = floor(screen)` shim: a press on the Out nub
    // at world (96.5,176) read as cell (96,176), so the first sample's walk spanned 264
    // cells by accident of the rig. Since 74.1 the press is resolved BY CELL, so that
    // accident no longer happens, and the over-long sample is now authored on purpose:
    // ONE sample far down the row, more than `BELT_WALK_MAX_CELLS` cells from the head,
    // in the real-camera rig.
    //
    // What the bound decides, stated exactly, because the obvious version of this claim
    // is wrong: the bound does NOT stop a long corridor being PAINTED through cells the
    // head is not adjacent to (the accumulator's manhattan test does that). Here the far
    // sample runs ALONG the row from the head, so every walked cell IS adjacent to the
    // last and would push: without the bound the preview would carry a path hundreds of
    // tiles long. The bound stops the walk being WALKED, and the observable is that the
    // discarded sample touches nothing.
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    // A LITERAL, never derived from the constant: a sample placed at `MAX + k` would move
    // with the constant and could never notice it being raised. The walk from the
    // doorstep (3,5) to (303,5) is 301 cells.
    const far = 303;
    // THE PRECONDITION, asserted against the constant rather than left a coincidence:
    // raise `BELT_WALK_MAX_CELLS` past 301 and the sample IS walked, and this line says
    // so before the behavioural assertions below redden on the walked corridor.
    expect(far + 1 - 3, 'the far sample is over the walk bound').toBeGreaterThan(BELT_WALK_MAX_CELLS);
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atPx(outDoor.x, outDoor.y) });
    const afterPress = rig.overlay.beltCalls.length;
    // NON-VACUITY: the press seeded a real preview on the doorstep.
    expect(rig.overlay.beltCalls.at(-1)?.tiles.map((t) => [t.cell_x, t.cell_y])).toEqual([[3, 5]]);
    rig.win.fire('pointermove', { target: rig.canvas, ...atC(far, 5) });
    expect(
      rig.overlay.beltCalls.length,
      'the over-long sample walked NOTHING, so the preview was not touched',
    ).toBe(afterPress);
    // Back on the board at a hand's pace. The sample back to (4,5) is over the bound
    // too and is discarded the same way; the walk from (4,5) on covers what it skipped.
    for (const cx of [4, 5, 6, 7]) {
      rig.win.fire('pointermove', { target: rig.canvas, ...atC(cx, 5) });
    }
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atPx(inNub.x, inNub.y) });

    // The shipped bytes: the discarded samples cost the path nothing.
    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({ kind: 'DrawBelt', cells: portToPortCells }),
    ]);
    const widest = Math.max(...rig.overlay.beltCalls.map((c) => c.tiles.length));
    expect(widest, 'no preview call in the gesture carried more than the 5 drawn tiles').toBe(5);
  });

  it("the walk bound's zoom floor mirrors the camera's", () => {
    // `gestures.ts` derives BELT_WALK_MAX_CELLS from a screen-px budget converted at
    // the camera's LOOSEST zoom, and it MIRRORS that zoom rather than importing it:
    // `input/` keeps out of `render/camera.ts`, which pulls pixi.js in at module load.
    // A mirrored constant with nothing holding it to its original is exactly the kind
    // of coupling this repository keeps discovering was never enforced, so this is the
    // thing that enforces it. A test file can afford the camera import; the shipped
    // input layer cannot.
    expect(BELT_WALK_MIN_ZOOM_MIRROR, 'the mirrored zoom floor equals the real one').toBe(MIN_ZOOM);
  });

  it('the walk bound admits exactly BELT_WALK_MAX_CELLS cells and discards one more', () => {
    // THE BOUND'S ONLY GATE (WR-01/WR-06, 2026-09-10). Before this case the constant's
    // exact value had no gate at all: the review flipped the in-loop check from `>` to
    // `>=`, tightening the effective bound by a whole cell, and nothing in the
    // repository reddened.
    //
    // The legacy shim maps cell = floor(screen), so screen units ARE cell units here
    // and a walk of exactly N cells is a press at 0.5 and one sample at N - 0.5. The
    // board is empty and the press is nowhere near a nub, so the draw takes the plain
    // cell seed at (0,0) and every walked cell is manhattan 1 from the head and pushes.
    //
    // Both arms are needed: the ADMITTED arm dies if the bound is tightened by one
    // (mutation J, `>` to `>=`), and the DISCARDED arm dies if it is loosened.
    //
    // WHAT THIS CASE CANNOT SAY, so nobody reads more into it than it holds: it takes
    // its magnitudes FROM the constant, so it moves with the constant and can never
    // pin the VALUE. It pins the relation between the two checks. The value's own
    // gates are elsewhere - `an over-long sample walks nothing` pins its ceiling
    // against the 264-cell legacy fixture, and the zoom-floor mirror case pins the
    // only other input to its derivation. Measured: raising the px budget so the bound
    // becomes 300 reddens the legacy case and leaves this one green.
    for (const [cells, admitted] of [
      [BELT_WALK_MAX_CELLS, true],
      [BELT_WALK_MAX_CELLS + 1, false],
    ] as Array<[number, boolean]>) {
      const r = setupRig();
      try {
        r.armBelt();
        r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...atPx(0.5, 0.5) });
        const afterPress = r.overlay.beltCalls.length;
        r.win.fire('pointermove', { target: r.canvas, ...atPx(cells - 0.5, 0.5) });
        const last = r.overlay.beltCalls.at(-1);
        if (admitted) {
          expect(
            r.overlay.beltCalls.length,
            `a ${cells}-cell sample is walked, so the preview moves`,
          ).toBeGreaterThan(afterPress);
          expect(last?.tiles.length, `and the whole ${cells}-cell run is drawn`).toBe(cells);
        } else {
          expect(
            r.overlay.beltCalls.length,
            `a ${cells}-cell sample is over the bound, so nothing is walked`,
          ).toBe(afterPress);
          expect(last?.tiles.length, 'and the path is still just the seed').toBe(1);
        }
      } finally {
        r.destroy();
      }
    }
  });

  // WR-02: the port-to-port DRAW endpoints must PREDICT medium consistently with the
  // drag-dock path. A belt is always Mechanical, so a wire (Electrical) nub can never
  // carry a dock — the affordance must not lie about that. Since Phase 64 the
  // affordance is all it is: the dock is recorded and emitted either way, and the
  // host's `MediumMismatch` is what the user reads.
  /** SOURCE with an ELECTRICAL Out nub (a Mechanical belt can never dock it). */
  const electricalSource = (): NodeView =>
    node({
      id: 1,
      kind: machine_kind.SOURCE,
      cell_x: 2,
      cell_y: 5,
      ports: [{ index: 0, cell_x: 2, cell_y: 5, side: 1, role: 1, medium: MEDIUM_ELECTRICAL }],
    });

  /** SINK with an ELECTRICAL In nub. */
  const electricalSink = (): NodeView =>
    node({
      id: 2,
      kind: machine_kind.SINK,
      cell_x: 8,
      cell_y: 5,
      ports: [{ index: 0, cell_x: 8, cell_y: 5, side: 3, role: 0, medium: MEDIUM_ELECTRICAL }],
    });

  // The SEVENTH suppression site (Phase 64, D-08 — the deviation from CONTEXT's
  // five-site list, approved on 2026-08-21) recorded the Tail dock on an
  // Electrical Out press and let the host answer MediumMismatch. REVERSED in
  // 74.1-11 (review WR-04). Old title: `WR-02 start: pressing an ELECTRICAL Out nub
  // shows a NON-accepting ring and emits a Tail dock the host refuses`. Since 74.1
  // the press target is the whole doorstep floor tile, so that choice made the tile
  // in front of every wire Out unusable as a plain start. The press now reads the
  // ring set's medium term: the doorstep is a plain seed. Same board.
  it('WR-02 start, reversed in 74.1-11: pressing an ELECTRICAL Out\'s doorstep is a plain seed: no ring, no Tail dock, the Head still docks', () => {
    rig = setupRigWith({ cellsFromWorld: true }, electricalSource(), sink());
    dragPortToPort(rig);

    // The belt still draws from the pressed cell (3,5)..(7,5).
    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({ kind: 'DrawBelt', cells: portToPortCells }),
    ]);
    // The press resolved no source: no ring of any kind on the wire Out's doorstep.
    expect(rig.overlay.nubRingCalls.some((c) => c.pt.x === outDoor.x && c.pt.y === outDoor.y)).toBe(false);

    // Echo the belt: NO Tail dock addresses the wire Out, so there is no refusal the
    // user never asked for. The mechanical sink In still docks Head, so the change
    // did not make the release over-narrow (NON-VACUITY: the follow-up did fire).
    // The host accepts the DrawBelt, minting belt 42 (plan 88-06, D-06).
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, echoBelt(42, portToPortCells));
    rig.flushRaf();
    const frames = rig.sent.slice(1).map((b) => [...b]);
    expect(frames).not.toContainEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Tail', node: 1, port: 0 }),
    ]);
    expect(frames).toEqual([
      [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Head', node: 2, port: 0 })],
    ]);
  });

  it('WR-02 end: releasing on an ELECTRICAL In nub flashes WHERE and emits a Head dock the host refuses', () => {
    rig = setupRigWith({ cellsFromWorld: true }, source(), electricalSink());
    dragPortToPort(rig);

    // The belt draws normally; the mechanical Out start still armed its Tail dock.
    expect(rig.sent).toHaveLength(1);
    expect(rig.sent[0][0]).toBe(3); // DrawBelt
    // The one-shot flash still fires over the wire In port cell (8,5). Its job is
    // LOCATION only now (D-10): it marks the cell the user aimed at, and the
    // host's `MediumMismatch` sentence is what says why.
    expect(rig.overlay.rejectFlashCalls).toContainEqual({
      cell: { cx: 8, cy: 5 },
      dims: { w: 1, h: 1, rot: 0 },
    });

    // Echo the belt: the mechanical Out still docks Tail, and the Head dock onto
    // the wire In IS emitted now instead of being dropped where nobody could see it.
    // The host accepts the DrawBelt, minting belt 42 (plan 88-06, D-06).
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, echoBelt(42, portToPortCells));
    rig.flushRaf();
    const frames = rig.sent.slice(1).map((b) => [...b]);
    expect(frames).toContainEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Tail', node: 1, port: 0 }),
    ]);
    expect(frames).toContainEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Head', node: 2, port: 0 }),
    ]);
  });

  // Defect D (WINDOWS row 77, widened). The belt-draw END took the SINGLE
  // NEAREST nub while the drag path was given a ranked nearest-ACCEPTING lookup
  // in this same phase. Recording a wrong-medium In port as the end dock also
  // SUPPRESSES the auto-dock fallback below, because that recovery only runs in
  // the `else` of `if (endDock)` - so the wrong-by-two-pixels nub does not just
  // address the wrong port, it takes the legal connection off the table.
  /**
   * An ELECTRICAL In nub at (7,4) facing S. Its facing cell is (7,5) - the SAME
   * tile the mechanical sink's W In port faces, so the two nubs sit ~22 world px
   * apart at zoom 1 and a release can be inside both 12px radii at once. This
   * overlap is ordinary board geometry, not a contrivance.
   */
  const electricalNeighbour = (): NodeView =>
    node({
      id: 3,
      kind: machine_kind.SINK,
      cell_x: 7,
      cell_y: 4,
      ports: [{ index: 0, cell_x: 7, cell_y: 4, side: 2, role: 0, medium: MEDIUM_ELECTRICAL }],
    });

  it('the belt-draw END docks the nearest ACCEPTING nub, not the nearest nub', () => {
    // 74.1: real-camera rig; the release point (247.5,168) is in cell (7,5).
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink(), electricalNeighbour());

    // The release point: inside BOTH nubs' hit radius, marginally nearer the
    // ELECTRICAL one. Asserted rather than asserted-by-comment, so the case
    // cannot quietly stop being the case it was written to be.
    const wrongNub = nubAnchor(7, 4, 2); // Electrical In  -> (240, 160.5)
    const rightNub = nubAnchor(8, 5, 3); // Mechanical In  -> (255.5, 176)
    const release = { x: 247.5, y: 168 };
    const dist = (n: { x: number; y: number }): number =>
      Math.hypot(n.x - release.x, n.y - release.y);
    expect(dist(wrongNub)).toBeLessThan(dist(rightNub));
    expect(dist(rightNub)).toBeLessThanOrEqual(nubHitRadiusWorld(1));

    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atPx(outDoor.x, outDoor.y) });
    for (const cx of [4, 5, 6, 7]) {
      rig.win.fire('pointermove', { target: rig.canvas, ...atC(cx, 5) });
    }
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atPx(release.x, release.y) });

    // The path the player saw is the path that emits (no facing-cell append —
    // the belt already ends on the tile both ports face).
    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({ kind: 'DrawBelt', cells: portToPortCells }),
    ]);

    // The host accepts the DrawBelt, minting belt 42 (plan 88-06, D-06).
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, echoBelt(42, portToPortCells));
    rig.flushRaf();

    // Head docks the MECHANICAL sink: the connection the user drew, which the
    // host accepts. Before this fix the Head dock named node 3's Electrical port
    // and the host answered MediumMismatch - the belt simply did not connect.
    expect(rig.sent.slice(1).map((b) => [...b])).toEqual([
      [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Tail', node: 1, port: 0 })],
      [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Head', node: 2, port: 0 })],
    ]);
    // No WHERE flash: nothing was refused, so nothing is marked.
    expect(rig.overlay.rejectFlashCalls).toHaveLength(0);
  });

  it('the belt-draw END still emits the refused Dock when NO accepting nub is in reach', () => {
    // The same overlap with the mechanical sink REMOVED: only the Electrical In
    // is reachable. D-08 is unchanged here - the user genuinely aimed at that
    // port, so it is addressed, the host answers MediumMismatch, and the user
    // reads it. The ranked lookup narrows WHICH port is addressed; it never
    // re-introduces the swallow.
    rig = setupRigWith({ cellsFromWorld: true }, source(), electricalNeighbour());
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atPx(outDoor.x, outDoor.y) });
    for (const cx of [4, 5, 6, 7]) {
      rig.win.fire('pointermove', { target: rig.canvas, ...atC(cx, 5) });
    }
    const wrongNub = nubAnchor(7, 4, 2);
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atPx(wrongNub.x, wrongNub.y) });

    expect(rig.overlay.rejectFlashCalls).toContainEqual({
      cell: { cx: 7, cy: 4 },
      dims: { w: 1, h: 1, rot: 0 },
    });
    // The host accepts the DrawBelt, minting belt 42 (plan 88-06, D-06).
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, echoBelt(42, portToPortCells));
    rig.flushRaf();
    expect(rig.sent.slice(1).map((b) => [...b])).toEqual([
      [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Tail', node: 1, port: 0 })],
      [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Head', node: 3, port: 0 })],
    ]);
  });

  it('auto-dock exactly-one: a plain draw ending adjacent-facing the In nub docks Head after the echo', () => {
    rig = setupRig(source(), sink());
    rig.armBelt();
    const cells: Array<[number, number]> = [
      [4, 5],
      [5, 5],
      [6, 5],
      [7, 5],
    ];
    // Plain draw: down on empty floor, drag east, release NOT near any nub
    // (the cell-coord release point sits far from the world-px nub anchors).
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(4, 5) });
    for (const cx of [5, 6, 7]) {
      rig.win.fire('pointermove', { target: rig.canvas, ...at(cx, 5) });
    }
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(7, 5) });

    expect(rig.sent).toHaveLength(1);
    expect(rig.sent[0][0]).toBe(3); // DrawBelt

    // The host accepts the DrawBelt, minting belt 42 (plan 88-06, D-06).
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, echoBelt(42, cells));
    rig.flushRaf();

    // EXACTLY one candidate (the sink In port) → exactly one Head Dock frame.
    expect(rig.sent).toHaveLength(2);
    expect([...rig.sent[1]]).toEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Head', node: 2, port: 0 }),
    ]);
  });

  it('auto-dock zero candidates: a release into open floor emits DrawBelt only', () => {
    rig = setupRig(source(), sink());
    rig.armBelt();
    const cells: Array<[number, number]> = [
      [4, 2],
      [5, 2],
      [6, 2],
    ];
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(4, 2) });
    for (const cx of [5, 6]) {
      rig.win.fire('pointermove', { target: rig.canvas, ...at(cx, 2) });
    }
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(6, 2) });

    expect(rig.sent).toHaveLength(1);
    // The host accepts the DrawBelt, minting belt 42 (plan 88-06, D-06).
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, echoBelt(42, cells));
    rig.flushRaf();
    rig.flushRaf(); // a re-scheduled poll (if any) still emits nothing
    expect(rig.sent).toHaveLength(1); // no follow-up frames
  });

  it('auto-dock two candidates: no Dock and no chooser (strict count === 1)', () => {
    // MOVED (phase 89, plan 89-05, D-02). This case pressed AND released on (7,5), the doorstep
    // both Ins share, as a plain one-cell draw; since D-02 a press there starts the REVERSED draw
    // into the first In, so it no longer reaches the auto-dock. The same two candidates are now
    // reached by a draw ARRIVING on (7,5) from the north, its head facing S: BOTH In ports
    // accept that head - the sink In/W at (8,5) and a second node's In/N at (7,6) - and the
    // release at the cell centre is 15.5 world px from each nub, outside the 12 px radius.
    // Count 2 -> nothing fires.
    const twoIn = node({
      id: 3,
      cell_x: 7,
      cell_y: 6,
      ports: [{ index: 0, cell_x: 7, cell_y: 6, side: 0, role: 0, medium: 0 }],
    });
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink(), twoIn);
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atC(7, 3) });
    rig.win.fire('pointermove', { target: rig.canvas, ...atC(7, 4) });
    rig.win.fire('pointermove', { target: rig.canvas, ...atC(7, 5) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atC(7, 5) });
    const drawn: Array<[number, number]> = [
      [7, 3],
      [7, 4],
      [7, 5],
    ];
    expect(rig.sent.map((f) => [...f])).toEqual([[...encodeGridCommand({ kind: 'DrawBelt', cells: drawn })]]);

    // The host accepts the DrawBelt, minting belt 42 (plan 88-06, D-06).
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, echoBelt(42, drawn));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent).toHaveLength(1); // zero Dock frames
  });

  it('a keyframe before the verdict keeps the follow-up: its accept and packet still send the Docks, addressed (D-06)', () => {
    // REWRITTEN (plan 88-06, D-06). This case was `keyframe abandon: clearSelection before
    // the echo kills every pending follow-up`: a full keyframe (an Undo's remint) ended the
    // follow-up so no Dock could name a reminted handle (T-21-13), and the belt landed
    // undocked with no message. The follow-up now waits for its own verdict, and its Docks
    // carry the generation their handles belong to, which the host resolves in that table
    // (plan 88-04). Here a resync keyframe of the same generation comes first.
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    dragPortToPort(rig);
    expect(rig.sent).toHaveLength(1);
    rig.clearSel();
    expect(rig.overlay.heldBelts.pictures, 'the held picture survives the keyframe').toHaveLength(1);
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, echoBelt(42, portToPortCells));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent.slice(1).map((b) => [...b]), 'the owed Tail and Head Docks').toEqual([
      [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Tail', node: 1, port: 0 })],
      [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Head', node: 2, port: 0 })],
    ]);
  });

  it('an_undo_keyframe_does_not_drop_an_owed_dock', () => {
    // Plan 88-06 (D-06, T-88-17): a DrawBelt accepted at generation 0 as belt 42, then an
    // Undo's keyframe of generation 1 arrives before any packet of generation 0 shows the
    // belt. The owed Docks go out once, addressed to belt 42 with generation 0, the table
    // their handles were read in; the host resolves them there or refuses them in words.
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    dragPortToPort(rig);
    acceptDraw(rig, 42, -1, 0);
    rig.flushRaf();
    expect(rig.sent, 'NON-VACUITY: no packet holds belt 42 yet, so nothing more is sent').toHaveLength(1);
    rig.scene.generation = 1;
    rig.clearSel();
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent.slice(1).map((b) => [...b]), 'both owed Docks, once').toEqual([
      [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Tail', node: 1, port: 0 })],
      [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Head', node: 2, port: 0 })],
    ]);
    expect(rig.sentOpts.slice(1), "addressed in the accept's table, generation 0").toEqual([
      { generation: 0 },
      { generation: 0 },
    ]);
    expect(rig.overlay.heldBelts.pictures, 'the held picture ends when the Docks go out').toEqual([]);
  });

  it("a_dock_claim_takes_the_role_of_the_target_the_user_drew_to (phase 88 review, WR-01)", () => {
    // A DrawBelt accepted at generation 0 as belt 42, then an Undo's keyframe of generation 1
    // comes first, in which handle 1 (the Source the Tail docks) names a BELT. The Dock still
    // goes out addressed to (generation 0, node 1), and its claim must take the Source's Out
    // (node 1, port 0), the role of the target recorded at the release, not a belt's Head
    // read off the newer scene.
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    dragPortToPort(rig);
    acceptDraw(rig, 42, -1, 0);
    rig.flushRaf();
    rig.scene.generation = 1;
    rig.scene.belts.set(1, echoBelt(1, [[12, 12], [13, 12]]));
    rig.clearSel();
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent.slice(1).map((b) => [...b])[0], 'PRECONDITION: the Tail Dock went out').toEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Tail', node: 1, port: 0 }),
    ]);
    expect(rig.sentClaims[1]?.sources, "the Tail Dock's claim takes the Source's Out").toEqual([{ node: 1, port: 0 }]);
  });

  it('a_belt_drawn_before_a_queued_undo_folds_docks_the_machines_it_was_drawn_between', () => {
    // Plan 88-06 (D-06): on a paused board the user presses Ctrl+Z (queued) and then draws a
    // docked belt on the board as it still shows (generation 0). On Play the Undo folds first,
    // reminting every handle (generation 1: the source is now 5, the sink 6), and the belt is
    // minted in that new table. One Dock frame carries one generation, so each machine is
    // named again in the accept's table from the packet that holds the belt: same kind, same
    // cell, the same port in the same place.
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    dragPortToPort(rig);
    const reminted = (n: NodeView, id: number): NodeView => ({ ...n, id });
    const src0 = rig.scene.nodes.get(1)!;
    const snk0 = rig.scene.nodes.get(2)!;
    rig.scene.nodes.clear();
    rig.scene.nodes.set(5, reminted(src0, 5));
    rig.scene.nodes.set(6, reminted(snk0, 6));
    rig.scene.generation = 1;
    rig.clearSel();
    acceptDraw(rig, 42, -1, 1);
    rig.scene.belts.set(42, echoBelt(42, portToPortCells));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent.slice(1).map((b) => [...b]), 'the Docks name the reminted machines').toEqual([
      [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Tail', node: 5, port: 0 })],
      [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Head', node: 6, port: 0 })],
    ]);
    expect(rig.sentOpts.slice(1), "in the accept's table").toEqual([{ generation: 1 }, { generation: 1 }]);
  });

  it('a belt drawn before a queued undo folds sends no Dock for a machine the undo removed, and none when the table moved on again', () => {
    // Plan 88-06 (D-06): the re-naming above needs exactly one match; a machine the Undo took
    // away gets no Dock (the other end still docks) and the belt's predicted seam ends. And
    // when a second keyframe has moved the board past the accept's table before its packet
    // came, nothing can be named in that table, so nothing is sent.
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    dragPortToPort(rig);
    const src0 = rig.scene.nodes.get(1)!;
    rig.scene.nodes.clear();
    rig.scene.nodes.set(5, { ...src0, id: 5 });
    rig.scene.generation = 1;
    rig.clearSel();
    acceptDraw(rig, 42, -1, 1);
    rig.scene.belts.set(42, echoBelt(42, portToPortCells));
    rig.flushRaf();
    expect(rig.sent.slice(1).map((b) => [...b]), 'only the Tail, onto the source that is still there').toEqual([
      [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Tail', node: 5, port: 0 })],
    ]);
    expect(pendingSeamsRecords(), 'the predicted seam ends: an expected end will not dock').toEqual([]);

    const r = setupRigWith({ cellsFromWorld: true }, source(), sink());
    try {
      dragPortToPort(r);
      r.scene.generation = 1;
      acceptDraw(r, 42, -1, 1);
      r.scene.generation = 2;
      r.clearSel();
      r.flushRaf();
      r.flushRaf();
      expect(r.sent, 'nothing past the DrawBelt').toHaveLength(1);
      expect(r.overlay.heldBelts.pictures, 'and the entry ended').toEqual([]);
    } finally {
      r.destroy();
    }
  });

  it('a belt whose accept table the scene skipped is named again in the newest table, with its machines (phase 88 review, IN-01)', () => {
    // A paused board: Ctrl+Z queued, then a docked draw on generation 0. On Play the Undo
    // folds first and the belt is minted as belt 42 in generation 1's table. Before any frame
    // shows generation 1, a second keyframe (a second Ctrl+Z released from the hold) moves the
    // scene to generation 2: the belt is 9 there, the source 7 and the sink 8. The packet of
    // generation 1 will never be seen, so the belt and both machines are named again in the
    // newest table by exact match, and both Docks go out addressed to generation 2. Until the
    // fix nothing was sent and the belt landed undocked with no word, the BELT-05 symptom.
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    dragPortToPort(rig);
    const src0 = rig.scene.nodes.get(1)!;
    const snk0 = rig.scene.nodes.get(2)!;
    acceptDraw(rig, 42, -1, 1);
    rig.scene.nodes.clear();
    rig.scene.nodes.set(7, { ...src0, id: 7 });
    rig.scene.nodes.set(8, { ...snk0, id: 8 });
    rig.scene.belts.set(9, echoBelt(9, portToPortCells));
    rig.scene.generation = 2;
    rig.clearSel();
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent.slice(1).map((b) => [...b]), 'the Docks name belt 9 and the machines 7 and 8').toEqual([
      [...encodeGridCommand({ kind: 'Dock', belt: 9, end: 'Tail', node: 7, port: 0 })],
      [...encodeGridCommand({ kind: 'Dock', belt: 9, end: 'Head', node: 8, port: 0 })],
    ]);
    expect(rig.sentOpts.slice(1), 'addressed in the newest table').toEqual([{ generation: 2 }, { generation: 2 }]);
    expect(rig.overlay.heldBelts.pictures, 'the held picture ends when the Docks go out').toEqual([]);
  });

  it('a swap keyframe before an accepted belt lands ends it with nothing sent, though the new board matches (phase 88, T-88-11, T-88-17)', () => {
    // The IN-01 order, then a swap: a paused board, Ctrl+Z queued, a docked draw on
    // generation 0; on Play the Undo folds first and the belt is minted as belt 42 in
    // generation 1's table. Before any frame shows generation 1, the keyframe of a Load (New,
    // Open, an example) moves the scene to generation 2, the host's new swap floor. The
    // loaded board happens to hold the same source and sink in the same places and a belt on
    // exactly the drawn cells. Re-naming the belt and its machines there and sending the Docks
    // stamped 2 would dock a belt the user never drew on this board: the host accepts a stamp
    // equal to the floor. The swap ends every held belt with nothing sent.
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    dragPortToPort(rig);
    const src0 = rig.scene.nodes.get(1)!;
    const snk0 = rig.scene.nodes.get(2)!;
    acceptDraw(rig, 42, -1, 1);
    expect(rig.waiting().belts, 'non-vacuity: the belt is held with its Docks owed').toBe(1);
    expect(rig.overlay.heldBelts.pictures, 'and its held picture is drawn').toHaveLength(1);
    rig.scene.nodes.clear();
    rig.scene.belts.clear();
    rig.scene.nodes.set(7, { ...src0, id: 7 });
    rig.scene.nodes.set(8, { ...snk0, id: 8 });
    rig.scene.belts.set(9, echoBelt(9, portToPortCells));
    rig.scene.generation = 2;
    rig.swap();
    rig.clearSel();
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent, 'nothing past the DrawBelt: no Dock onto the loaded board').toHaveLength(1);
    expect(rig.overlay.heldBelts.pictures, 'the held picture ends with it').toEqual([]);
    expect(rig.waiting(), 'nothing is left waiting').toEqual({ placements: 0, belts: 0, docks: 0 });
  });

  it('a Load this page did not ask for still ends an accepted belt with nothing sent: the packet names the swap floor (phase 88, T-88-11, T-88-17 re-audit)', () => {
    // The case above with no `onSwap`. App calls it only when this page asked for the swap
    // (`claimSwapRef`), so a Load from a second dev-WebSocket client, or a swap whose claim an
    // Undo keyframe used up first, never reaches it, and the IN-01 branch named the belt and
    // its machines again on the loaded board and sent the Docks stamped 2. The keyframe's own
    // swap floor (2, above the accept's 1) says the accept was written on a replaced board.
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    dragPortToPort(rig);
    const src0 = rig.scene.nodes.get(1)!;
    const snk0 = rig.scene.nodes.get(2)!;
    acceptDraw(rig, 42, -1, 1);
    expect(rig.waiting().belts, 'non-vacuity: the belt is held with its Docks owed').toBe(1);
    rig.scene.nodes.clear();
    rig.scene.belts.clear();
    rig.scene.nodes.set(7, { ...src0, id: 7 });
    rig.scene.nodes.set(8, { ...snk0, id: 8 });
    rig.scene.belts.set(9, echoBelt(9, portToPortCells));
    rig.scene.generation = 2;
    rig.scene.swapFloor = 2;
    rig.clearSel();
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent, 'nothing past the DrawBelt: no Dock onto the loaded board').toHaveLength(1);
    expect(rig.overlay.heldBelts.pictures, 'the held picture ends with it').toEqual([]);
    expect(rig.waiting(), 'nothing is left waiting').toEqual({ placements: 0, belts: 0, docks: 0 });
  });

  // MOVED BY PLAN 89-07 (D-11, WINDOWS 246, research Pitfall 8). This case used to be `keyframe MID
  // port-to-port draw drops the recorded source dock and the drawn path (WR-04)`: a keyframe killed
  // the path with its start dock, so the release sent nothing. D-11 keeps the path and re-resolves
  // only the start dock. WR-04's rule, "No Dock may ever target a remint", still holds, and this
  // case is what pins it now: the source is reminted (handle 1 becomes 5) and the Tail Dock that
  // follows names 5, never the stale 1.
  it('a_keyframe_mid_draw_re_resolves_the_start_dock', () => {
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atPx(outDoor.x, outDoor.y) });
    expect(rig.overlay.nubRingCalls, 'NON-VACUITY: the press recorded the source').toContainEqual({ pt: outDoor, armed: true });
    for (const x of [4.25, 4.75, 5.25, 5.6]) {
      rig.win.fire('pointermove', { target: rig.canvas, ...atPx(x * CELL, 5 * CELL + 15) });
    }
    expect(rig.overlay.beltCalls.at(-1)?.tiles.map((t) => [t.cell_x, t.cell_y])).toEqual([
      [3, 5],
      [4, 5],
      [5, 5],
    ]);
    // The keyframe: the host's table rebuilt, the same Source now under handle 5.
    rig.scene.nodes.delete(1);
    rig.scene.nodes.set(5, { ...source(), id: 5 });
    const rings = rig.overlay.nubRingCalls.length;
    const shown = rig.overlay.beltCalls.length;
    rig.clearSel();
    expect(rig.overlay.beltPreview.on, 'the preview is repainted on the same frame, never blinking out').toBe(true);
    expect(rig.overlay.beltCalls.length, 'repainted by the keyframe itself').toBeGreaterThan(shown);
    expect(rig.overlay.beltCalls.at(-1)?.tiles.map((t) => [t.cell_x, t.cell_y]), 'the drawn path kept').toEqual([
      [3, 5],
      [4, 5],
      [5, 5],
    ]);
    expect(rig.overlay.nubRingCalls.slice(rings), 'the armed start ring repainted on the doorstep').toContainEqual({ pt: outDoor, armed: true });
    for (const x of [6.25, 6.75, 7.25, 7.5]) {
      rig.win.fire('pointermove', { target: rig.canvas, ...atPx(x * CELL, 5 * CELL + 16) });
    }
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atPx(inNub.x, inNub.y) });
    expect(rig.sent.map((f) => [...f]), 'ONE DrawBelt with every drawn cell').toEqual([
      [...encodeGridCommand({ kind: 'DrawBelt', cells: portToPortCells })],
    ]);
    acceptDraw(rig, 42, 0);
    rig.scene.belts.set(42, echoBelt(42, portToPortCells));
    rig.flushRaf();
    rig.flushRaf();
    const docks = rig.sent.filter((f) => f[0] === 4).map((f) => [...f]);
    expect(docks, 'the Tail Dock names the re-resolved handle 5, never the stale 1; the Head docks the Sink').toEqual([
      [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Tail', node: 5, port: 0 })],
      [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Head', node: 2, port: 0 })],
    ]);
  });

  it('a_keyframe_mid_draw_drops_a_start_dock_that_no_longer_resolves', () => {
    // The keyframe's table has no Out on the pressed doorstep any more (an Undo removed the
    // Source): the start dock is dropped, the armed ring goes, and the draw goes on as a plain
    // start. The release sends every drawn cell and no Tail Dock; the Head still docks the Sink.
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atPx(outDoor.x, outDoor.y) });
    for (const x of [4.25, 4.75, 5.25, 5.6]) {
      rig.win.fire('pointermove', { target: rig.canvas, ...atPx(x * CELL, 5 * CELL + 15) });
    }
    rig.scene.nodes.delete(1);
    const rings = rig.overlay.nubRingCalls.length;
    rig.clearSel();
    expect(rig.overlay.beltPreview.on, 'the preview is repainted on the same frame').toBe(true);
    expect(rig.overlay.nubRingCalls.slice(rings), 'no armed start ring: nothing resolves on the doorstep').toEqual([]);
    for (const x of [6.25, 6.75, 7.25, 7.5]) {
      rig.win.fire('pointermove', { target: rig.canvas, ...atPx(x * CELL, 5 * CELL + 16) });
    }
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atPx(inNub.x, inNub.y) });
    expect(rig.sent.map((f) => [...f]), 'ONE DrawBelt with every drawn cell').toEqual([
      [...encodeGridCommand({ kind: 'DrawBelt', cells: portToPortCells })],
    ]);
    acceptDraw(rig, 42, 0);
    rig.scene.belts.set(42, echoBelt(42, portToPortCells));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent.filter((f) => f[0] === 4).map((f) => [...f]), 'no Tail Dock; the Head docks the Sink').toEqual([
      [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Head', node: 2, port: 0 })],
    ]);
  });

  it('a follow-on draw on OTHER cells leaves the earlier entry: its own accept and packet still send its Docks (WR-05, 74.1-30, D-06)', () => {
    // NAMED CHANGED OUTCOME (plan 74.1-30, PAUSE-SECOND-DRAW). Until then every DrawBelt
    // abandoned the single pending slot, so this case pinned that an echo of the first
    // draw's cells fired nothing. While paused that same rule dropped the Docks of every
    // belt but the last one drawn. Each committed DrawBelt now keeps its own entry, keyed
    // since plan 88-06 by its DrawBelt's gesture id (D-06): WR-05's hazard (a stale entry
    // matching a LATER identical redraw) cannot arise, because an entry lands only on the
    // belt its own accept names.
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    dragPortToPort(rig);
    expect(rig.sent).toHaveLength(1);

    // The user draws a plain path elsewhere (no nub hit, no docks).
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atC(4, 2) });
    rig.win.fire('pointermove', { target: rig.canvas, ...atC(5, 2) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atC(5, 2) });
    expect(rig.sent).toHaveLength(2); // two DrawBelts

    // The FIRST belt is accepted as 42 and echoes: its Tail and Head Docks go out, once each.
    acceptDraw(rig, 42, 0);
    rig.scene.belts.set(42, echoBelt(42, portToPortCells));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent.filter((f) => f[0] === 4), "the first belt's two Docks").toHaveLength(2);
    expect(rig.sent).toHaveLength(4);
  });

  it('a redraw with EXACTLY the same cells while the first waits is drawn red and sent with no claim: one entry, one set of Docks (WR-05, D-06, BELT-06, D-13)', () => {
    // MOVED (plan 88-07, BELT-06, D-09), and again by plan 89-09 (D-13). Until 88-07 the redraw
    // was sent: two entries until the host answered, which kept the first and refused the
    // second `FootprintCollision`. The first draw's claim takes its cells and its source in the
    // one occupancy read, so the redraw, over the same cells off the same doorstep, is
    // previewed red. Since 89-09 the belt path check no longer decides WHETHER: the red redraw
    // is sent so the host answers it in words, but as a predicted-illegal send it carries no
    // claim and arms no entry, so there is still one entry and one set of Docks.
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    dragPortToPort(rig);
    expect(rig.sent, 'NON-VACUITY: the first draw went out').toHaveLength(1);
    // The same drag again, the Belt tool still armed (a second `armBelt` would toggle it off).
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atPx(outDoor.x, outDoor.y) });
    for (const cx of [4, 5, 6, 7]) {
      rig.win.fire('pointermove', { target: rig.canvas, ...atC(cx, 5) });
    }
    expect(rig.overlay.beltCalls.at(-1)?.valid, 'the redraw is drawn as not allowed').toBe(false);
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atPx(inNub.x, inNub.y) });
    expect(rig.sent, 'and is sent, so the host says why').toHaveLength(2);
    expect(rig.sent[1][0], 'as a DrawBelt').toBe(DRAW_BELT_DISC);
    expect(rig.sentClaims[1], 'with no claim of its own').toBeUndefined();
    expect(rig.overlay.heldBelts.pictures, 'one entry, one held picture').toHaveLength(1);
    acceptDraw(rig, 42, 0);
    rig.scene.belts.set(42, echoBelt(42, portToPortCells));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent.filter((f) => f[0] === 4), 'one Tail and one Head Dock').toHaveLength(2);
    expect(rig.overlay.heldBelts.pictures, 'the entry ended').toEqual([]);
  });

  it('a_second_draw_on_the_same_cells_keeps_the_first_belts_predicted_corner (88-06 carried item, BELT-06)', () => {
    // The item plan 88-06 carried: predicted seams keep last-wins on equal cells, so a second
    // paused draw on exactly the first's cells replaced the first's seam record, and when the
    // host refused that second draw its refusal ended the only record: the first belt landed
    // drawn Straight at its docked seam until its Dock echoed. Since plan 88-07 the second draw
    // is red and is never sent, so it records nothing. Written so it runs on either rig: a
    // second DrawBelt, when one was sent, is refused as the host refuses it.
    //
    // The board: the Source's Out faces E onto its doorstep (3,5) and the draw turns S at once,
    // so the docked Tail seam is a corner (fed E, running S) that route() alone draws Straight.
    const turned: Array<[number, number]> = [
      [3, 5],
      [3, 6],
      [3, 7],
    ];
    const drawTurned = (): void => {
      rig!.canvas.fire('pointerdown', { button: 0, target: rig!.canvas, ...atPx(outDoor.x, outDoor.y) });
      for (const cy of [6, 7]) {
        rig!.win.fire('pointermove', { target: rig!.canvas, ...atC(3, cy) });
      }
      rig!.win.fire('pointerup', { button: 0, target: rig!.canvas, ...atC(3, 7) });
    };
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    rig.setPlaying(false);
    rig.armBelt();
    drawTurned();
    expect(drawIds(rig), 'NON-VACUITY: the first draw went out').toHaveLength(1);
    drawTurned();
    const second = drawIds(rig)[1];
    console.log(`P88-B6-SEAM drawsSent=${drawIds(rig).length}`);
    if (second !== undefined) {
      rig.refuse(second, 'FootprintCollision');
    }
    rig.setPlaying(true);
    acceptDraw(rig, 42, 0);
    const belt = echoBelt(42, turned);
    rig.scene.belts.set(42, belt);
    rig.flushRaf();
    const predicted = pendingSeamTiles(belt, rig.scene.tick, true);
    expect(predicted, "the first belt's predicted seam stands until its Dock echoes").not.toBeNull();
    expect(belt.tiles[0].kind, "NON-VACUITY: route() alone draws the seam Straight").toHaveProperty('Straight');
    expect(predicted?.[0].kind, 'and the predicted seam is the corner').toHaveProperty('Corner');
  });

  it('the follow-up entry expires after the tick TTL with no verdict (WR-05, D-07: the lost-verdict fallback)', () => {
    // MOVED (plan 88-06): the expiry is now the fallback for a verdict that never came, and it
    // counts playing ticks only (the rig plays by default). The late arrivals are now an
    // accept AND the packet, either of which used to be enough or needed.
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    dragPortToPort(rig);
    expect(rig.sent).toHaveLength(1);

    // No verdict lands and the sim plays past ECHO_TTL_TICKS (120): the
    // watcher abandons instead of scanning every frame forever.
    rig.scene.tick = 121;
    rig.flushRaf();

    // Fully abandoned: a late accept and its packet trigger nothing.
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, echoBelt(42, portToPortCells));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent).toHaveLength(1); // zero Dock frames
  });

  // Phase 88 probe (plan 88-01, BELT-05, D-07), red at PHASE88_START and turned on by plan
  // 88-06, which ends a belt follow-up on its own verdict and stops counting drained ticks.
  it(
    'a_belt_drawn_during_a_drain_keeps_its_dock',
    () => {
      // The user presses Pause at tick 40 and draws a docked belt at once. The host keeps
      // ticking while it drains (up to 512 ticks on a board with items on its belts) and
      // folds no gesture until Play, so the scene tick reaches 190 while the DrawBelt waits.
      // Then Play: the host accepts the DrawBelt, minting belt 42, and the belt echoes. The
      // Docks the draw owes must still go out.
      rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
      rig.scene.tick = 40;
      rig.setPlaying(false);
      dragPortToPort(rig);
      const draw = rig.sent.length;
      rig.scene.tick = 190;
      rig.flushRaf();
      rig.setPlaying(true);
      rig.scene.tick = 191;
      rig.verdict({ kind: 'gestureAccepted', seq: draw, generation: 0, minted: [42] });
      rig.scene.belts.set(42, echoBelt(42, portToPortCells));
      rig.flushRaf();
      rig.flushRaf();

      const dockFrames = rig.sent.filter((f) => f[0] === 4).map((f) => [...f]);
      console.log(
        `P88-B5 draw=${draw} dockFrames=${JSON.stringify(dockFrames)} held=${rig.overlay.heldBelts.pictures.length}`,
      );
      expect(draw, 'PRECONDITION: one DrawBelt was sent at the release').toBe(1);
      expect(dockFrames, 'the Tail and Head Docks the draw owes go out after its echo').toEqual([
        [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Tail', node: 1, port: 0 })],
        [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Head', node: 2, port: 0 })],
      ]);
      expect(rig.sentOpts.slice(1), "both Docks carry the accept's generation (plan 88-06)").toEqual([
        { generation: 0 },
        { generation: 0 },
      ]);
    },
  );

  it('a_belt_accept_lands_on_the_next_frame_not_between_frames', () => {
    // Plan 88-06: the host writes a tick's packet before its accepts, so the belt is usually in
    // the scene when the accept arrives. The Docks still go out from the next frame, as the
    // echo watcher always sent them, so a frame draws the minted belt (with its predicted
    // seam) before its Dock can fold; `74.1-release-and-undo` leg 5 grades that frame live.
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    dragPortToPort(rig);
    rig.scene.belts.set(42, echoBelt(42, portToPortCells));
    acceptDraw(rig, 42);
    expect(rig.sent, 'nothing goes out from the verdict handler').toHaveLength(1);
    expect(rig.overlay.heldBelts.pictures, 'and the held picture is still up').toHaveLength(1);
    rig.flushRaf();
    expect(rig.sent.filter((f) => f[0] === 4), 'the next frame sends both Docks').toHaveLength(2);
    expect(rig.overlay.heldBelts.pictures, 'and hands the picture over to the drawn belt').toEqual([]);
  });

  it('a_refused_belt_ends_its_held_picture_at_once', () => {
    // Plan 88-06 (D-06): a DrawBelt the host refuses never mints, so its held picture and its
    // predicted seam go in the frame the refusal arrives, not 120 ticks later, and no Dock is
    // ever sent for it, even when a belt with its cells shows up afterwards.
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    dragPortToPort(rig);
    expect(rig.overlay.heldBelts.pictures, 'NON-VACUITY: the release holds its picture').toHaveLength(1);
    expect(pendingSeamsRecords(), 'NON-VACUITY: and records its predicted seam').toHaveLength(1);
    rig.refuse(drawIds(rig)[0], 'FootprintCollision');
    expect(rig.overlay.heldBelts.pictures, 'the held picture is gone in the same call').toEqual([]);
    expect(pendingSeamsRecords(), 'and so is its predicted seam').toEqual([]);
    rig.scene.belts.set(42, echoBelt(42, portToPortCells));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent.filter((f) => f[0] === 4), 'no Dock is sent for a refused draw').toEqual([]);
  });

  it('a DrawBelt sent with no transport holds no picture and records no seam (phase 88 review, IN-05)', () => {
    rig = setupRigWith({ cellsFromWorld: true, noTransport: true }, source(), sink());
    dragPortToPort(rig);
    expect(rig.sent, 'PRECONDITION: the DrawBelt was attempted').toHaveLength(1);
    expect(rig.overlay.heldBelts.pictures, 'no held picture for a belt that was not sent').toEqual([]);
    expect(pendingSeamsRecords(), 'and no predicted seam').toEqual([]);
    expect(rig.waiting().belts, 'and nothing waits').toBe(0);
  });

  it('a sent Dock whose verdict never comes is forgotten on the playing-tick fallback (phase 88 review, IN-05)', () => {
    // The Dock-owner map held an entry per Dock sent until teardown when its verdict never
    // came (a dev WebSocket reconnect). It now ends on the same playing-tick fallback as every
    // other record of a gesture: paused ticks never count, Resume restarts the count.
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    dragPortToPort(rig);
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, echoBelt(42, portToPortCells));
    rig.flushRaf();
    expect(rig.sent, 'PRECONDITION: the two Docks went out').toHaveLength(3);
    expect(rig.waiting().docks, 'PRECONDITION: two Docks wait for their verdicts').toBe(2);
    rig.setPlaying(false);
    rig.scene.tick += 600;
    rig.flushRaf();
    expect(rig.waiting().docks, 'a paused drain never ends them').toBe(2);
    rig.setPlaying(true);
    rig.resume(rig.scene.tick);
    rig.scene.tick += 120;
    rig.flushRaf();
    expect(rig.waiting().docks, '120 playing ticks after Resume: still waiting').toBe(2);
    rig.scene.tick += 1;
    rig.flushRaf();
    expect(rig.waiting().docks, '121: forgotten').toBe(0);
  });

  it('a_lost_belt_verdict_ends_on_playing_ticks_only', () => {
    // Plan 88-06 (D-07): the fallback for a DrawBelt whose verdict never comes counts only
    // ticks run while playing, and Resume restarts it. A paused board drains with input held
    // (up to 512 ticks), and none of those ticks is evidence the draw was refused.
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    rig.scene.tick = 40;
    rig.setPlaying(false);
    dragPortToPort(rig);
    rig.scene.tick = 40 + 600;
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.overlay.heldBelts.pictures, 'a 600-tick drain keeps the held picture').toHaveLength(1);
    expect(pendingSeamsRecords(), 'and its predicted seam').toHaveLength(1);
    // Play at tick 640: the count restarts there.
    rig.setPlaying(true);
    rig.resume(640);
    rig.scene.tick = 640 + 120;
    rig.flushRaf();
    expect(rig.overlay.heldBelts.pictures, '120 playing ticks after Resume: still held').toHaveLength(1);
    rig.scene.tick = 640 + 121;
    rig.flushRaf();
    expect(rig.overlay.heldBelts.pictures, 'one playing tick past the fallback: gone').toEqual([]);
    expect(pendingSeamsRecords(), 'its predicted seam ends with it').toEqual([]);
    // Nothing was sent, and a late accept and its packet send nothing either.
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, echoBelt(42, portToPortCells));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent, 'the DrawBelt alone, no Dock').toHaveLength(1);
  });

  it('nub hover priority: idle move within 12px of a nub shows the passive nub ring and NO body hover ring', () => {
    // A synthetic body node whose 1x1 footprint cell sits exactly under the
    // Out nub's floor()ed cell coords — proving the nub hit WINS over the
    // body hover fallback when both match (D-10 locked priority).
    const body = node({
      id: 9,
      cell_x: Math.floor(outNub.x),
      cell_y: Math.floor(outNub.y),
    });
    rig = setupRig(source(), sink(), body);

    rig.win.fire('pointermove', { target: rig.canvas, ...atPx(outNub.x, outNub.y) });
    expect(rig.overlay.nubRingCalls).toEqual([{ pt: outNub, armed: false }]);
    expect(rig.overlay.hoverRingCalls).toHaveLength(0); // body ring suppressed

    // Leaving the nub's hit radius clears the passive ring.
    rig.win.fire('pointermove', { target: rig.canvas, ...atPx(600, 600) });
    expect(rig.overlay.nubRingCleared.count).toBeGreaterThan(0);
  });

  it('an in-nub release whose facing cell is occupied emits the previewed path AND its unreachable Head dock (WR-09)', () => {
    // NO SOURCE ON THIS BOARD since 74.1. The press below is at legacy cell (3,5),
    // which is the source Out's DOORSTEP, and a Belt-armed press there now starts a
    // DOCKED draw and adds a Tail dock this case is not about. The source never took
    // part in it: the subject is the In-nub release.
    //
    // THE LEGACY RIG IS KEPT HERE ON PURPOSE, unlike its neighbours. Under the real
    // camera the release on the In nub at world (255.5,176) is inside cell (7,5), so
    // the pointer itself sweeps the occupied facing cell, the preview turns red and
    // nothing emits: the blue-path-then-occupied-append premise of WR-09 is reachable
    // only where the release walk is discarded, which the legacy shim does.
    rig = setupRig(sink());
    // An existing single-tile belt occupies the In port's facing cell (7,5):
    // appending it would make the whole draw illegal.
    rig.scene.belts.set(9, echoBelt(9, [[7, 5]]));
    rig.armBelt();

    // Draw (3,5)..(6,5) — the last preview the player sees is build-blue.
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(3, 5) });
    for (const cx of [4, 5, 6]) {
      rig.win.fire('pointermove', { target: rig.canvas, ...at(cx, 5) });
    }
    expect(rig.overlay.beltCalls.at(-1)?.valid).toBe(true);

    // Release ON the In nub: the facing-cell append would overlap (7,5).
    // The emit must fall back to the previewed (un-appended) path — blue
    // means something emits, never a silent drop.
    rig.win.fire('pointerup', {
      button: 0,
      target: rig.canvas,
      ...atPx(inNub.x, inNub.y),
    });
    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({
        kind: 'DrawBelt',
        cells: [
          [3, 5],
          [4, 5],
          [5, 5],
          [6, 5],
        ],
      }),
    ]);

    // The recorded Head dock is emitted anyway (Phase 64, D-08). The belt's Head
    // end (6,5) is not the port's facing cell, so the host refuses it — and that
    // is the point: the follow-up used to re-verify with `acceptsDock` and drop it
    // in silence, which is how a user got a belt that mysteriously would not
    // connect and no line of text anywhere. The DrawBelt half is unaffected: the
    // previewed path is still what emits, because the belt draw is the one
    // suppression this phase kept.
    const drawn: Array<[number, number]> = [
      [3, 5],
      [4, 5],
      [5, 5],
      [6, 5],
    ];
    // The host accepts the DrawBelt, minting belt 42 (plan 88-06, D-06).
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, echoBelt(42, drawn));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent).toHaveLength(2);
    expect([...rig.sent[1]]).toEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Head', node: 2, port: 0 }),
    ]);
  });

  it('an in-nub release with a FREE facing cell still appends it (WR-09 regression)', () => {
    // No source, for the reason the case above gives: legacy cell (3,5) is its doorstep.
    rig = setupRig(sink());
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(3, 5) });
    for (const cx of [4, 5, 6]) {
      rig.win.fire('pointermove', { target: rig.canvas, ...at(cx, 5) });
    }
    rig.win.fire('pointerup', {
      button: 0,
      target: rig.canvas,
      ...atPx(inNub.x, inNub.y),
    });

    // The facing cell (7,5) is free: the path terminates where the port looks.
    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({
        kind: 'DrawBelt',
        cells: [
          [3, 5],
          [4, 5],
          [5, 5],
          [6, 5],
          [7, 5],
        ],
      }),
    ]);
  });

  // T-21-15 rotate-mid-wait, inverted by Phase 64 (D-08). The follow-up used to
  // re-verify each recorded dock against the node's CURRENT ports and silently
  // drop a failing one. A user who rotated the sink while the belt was in flight
  // therefore lost the dock with no belt connection, no flash and no log line —
  // the exact shape of failure this phase exists to end. Both docks go out now
  // and the host refuses the stale one in words.
  it('rotate-mid-wait: a dock whose port no longer accepts at echo time is emitted anyway, for the host to refuse', () => {
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    dragPortToPort(rig);
    expect(rig.sent).toHaveLength(1);

    // The sink rotates mid-wait: its In port now faces N, so the recorded
    // Head dock no longer satisfies the host predicate (adjacency to (7,5) breaks).
    rig.scene.nodes.get(2)!.ports[0].side = 0;

    // The host accepts the DrawBelt, minting belt 42 (plan 88-06, D-06).
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, echoBelt(42, portToPortCells));
    rig.flushRaf();

    // BOTH docks go out, in the recorded order: the still-valid Tail, then the
    // stale Head the host will answer for.
    expect(rig.sent).toHaveLength(3);
    expect([...rig.sent[1]]).toEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Tail', node: 1, port: 0 }),
    ]);
    expect([...rig.sent[2]]).toEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Head', node: 2, port: 0 }),
    ]);
  });

  // ---------------------------------------------------------------------------
  // Phase 89 red-first probes (plan 89-01, D-01, D-16). Each was gated and seen red at
  // PHASE89_START, and the plan that fixed it turned it on: that plan removed the gate and the
  // red-first title suffix and changed nothing else, so the test that is green is the test that
  // was seen red. Since plan 89-09 none is gated. Each prints its
  // measured facts on `P89-` lines before it asserts. Every drag below moves in sub-cell
  // samples, never one clean cell per event.
  // ---------------------------------------------------------------------------

  /** The Source Out's and the Sink In's owed Docks for belt 42, in order (Tail then Head). */
  const p89OwedDocks = (): number[][] => [
    [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Tail', node: 1, port: 0 })],
    [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Head', node: 2, port: 0 })],
  ];
  /** Move the pointer along row y from x0 to x1 (inclusive of x1) in `step` world px samples. */
  const p89Walk = (r: Rig, x0: number, x1: number, y: number, step: number): void => {
    const dir = Math.sign(x1 - x0);
    for (let x = x0; dir * (x1 - x) > 0; x += dir * step) {
      r.win.fire('pointermove', { target: r.canvas, ...atPx(x, y) });
    }
    r.win.fire('pointermove', { target: r.canvas, ...atPx(x1, y) });
  };

  it(
    'a_draw_pressed_on_an_in_doorstep_flows_into_that_in',
    () => {
      // BELT-01 (D-02): a draw pressed on the Sink In's doorstep (7,5) and released on the Source
      // Out's doorstep (3,5) is the belt drawn the other way: ONE DrawBelt from the Out doorstep to
      // the In doorstep, then a Tail Dock to the Out and a Head Dock to the In.
      rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
      rig.armBelt();
      const y = outDoor.y + 3;
      rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atPx(7 * CELL + CELL / 2, y) });
      p89Walk(rig, 7 * CELL + CELL / 2 - 6, outDoor.x, y, 6);
      rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atPx(outDoor.x, y) });
      const drawn = rig.sent.map((f) => [...f]);
      if (drawIds(rig).length > 0) {
        acceptDraw(rig, 42);
      }
      rig.scene.belts.set(42, echoBelt(42, portToPortCells));
      rig.flushRaf();
      rig.flushRaf();
      console.log(`P89-BELT-01 drawn=${JSON.stringify(drawn)} docks=${JSON.stringify(rig.sent.slice(1).map((f) => [...f]))}`);
      expect(drawn, 'ONE DrawBelt, its cells from the Out doorstep to the pressed In doorstep').toEqual([
        [...encodeGridCommand({ kind: 'DrawBelt', cells: portToPortCells })],
      ]);
      expect(rig.sent.slice(1).map((f) => [...f]), 'a Tail Dock to the Out and a Head Dock to the pressed In').toEqual(
        p89OwedDocks(),
      );
    },
  );

  // ---------------------------------------------------------------------------
  // Phase 89, plan 89-05 (D-02, BELT-01, UI-SPEC 1.1 and 1.2): a draw pressed on an input
  // ---------------------------------------------------------------------------

  /** Pointer at a world point (the real-camera rig: screen px == world px). */
  const p89Press = (r: Rig, x: number, y: number): void =>
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...atPx(x, y) });
  const p89Release = (r: Rig, x: number, y: number): void =>
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...atPx(x, y) });
  /** Walk the pointer through world points in `step` px samples, each leg a straight line. */
  const p89WalkThrough = (r: Rig, pts: Array<{ x: number; y: number }>, step: number): void => {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
      for (let k = 1; k <= n; k++) {
        r.win.fire('pointermove', { target: r.canvas, ...atPx(a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n) });
      }
    }
  };
  /** The world centre of cell (cx, cy). */
  const p89Centre = (cx: number, cy: number) => ({ x: cx * CELL + CELL / 2, y: cy * CELL + CELL / 2 });

  it('a_draw_from_an_in_released_on_floor_flows_into_it', () => {
    // D-02's open choice, decided: a draw pressed on the Sink In's doorstep (7,5) and released on
    // empty floor at (5,5) still flows INTO the pressed In. ONE DrawBelt from the floor end to the
    // doorstep, then ONE Head Dock to the Sink's In and no Tail Dock (the Tail is free).
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    rig.armBelt();
    const y = inNub.y - 4;
    p89Press(rig, 7 * CELL + 20, y);
    p89Walk(rig, 7 * CELL + 14, 5 * CELL + 12, y, 5);
    p89Release(rig, 5 * CELL + 12, y);
    const reversed: Array<[number, number]> = [
      [5, 5],
      [6, 5],
      [7, 5],
    ];
    expect(rig.sent.map((f) => [...f]), 'ONE DrawBelt, its cells from the hand to the pressed doorstep').toEqual([
      [...encodeGridCommand({ kind: 'DrawBelt', cells: reversed })],
    ]);
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, echoBelt(42, reversed));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent.slice(1).map((f) => [...f]), 'ONE Head Dock into the pressed In, no Tail Dock').toEqual([
      [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Head', node: 2, port: 0 })],
    ]);
  });

  it('the_press_set_equals_the_ring_set_with_in_doorsteps', () => {
    // UI-SPEC 1.1 and A10, the press-set-equals-ring-set rule with the In term: on one board that
    // holds every kind of doorstep, a press on EVERY cell of the board's box starts a docked draw
    // (an armed ring) exactly where a resting ring is painted. The board:
    //   - Source 1 (2,5) Out E -> doorstep (3,5): rings (a);
    //   - Sink 2 (8,5) In W -> doorstep (7,5): rings (c), the reversed start;
    //   - Sink 3 (5,2) In S -> doorstep (5,3), and Source 4 (6,3) Out W -> doorstep (5,3): ONE
    //     shared doorstep, concentric rings (a) and (c), and the press resolves to the Out;
    //   - Sink 5 (2,1) ELECTRICAL In E -> doorstep (3,1): no ring, a plain seed;
    //   - Sink 6 (10,2) In W -> doorstep (9,2), which belt 30's Head tile sits on (an In that is
    //     fed): no ring, no reversal;
    //   - belt 30 (9,0) -> (9,2) runs S, undocked, so its free Head rings on its own doorstep
    //     (9,3) (b).
    // A ring a press does not arm, or an armed press with no ring, reddens the comparison.
    const sinkAt = (id: number, cx: number, cy: number, side: number, medium = 0): NodeView =>
      node({
        id,
        kind: machine_kind.SINK,
        cell_x: cx,
        cell_y: cy,
        ports: [{ index: 0, cell_x: cx, cell_y: cy, side, role: 0, medium }],
      });
    const sourceAt = (id: number, cx: number, cy: number, side: number): NodeView =>
      node({
        id,
        kind: machine_kind.SOURCE,
        cell_x: cx,
        cell_y: cy,
        ports: [{ index: 0, cell_x: cx, cell_y: cy, side, role: 1, medium: 0 }],
      });
    const board = (): NodeView[] => [
      source(),
      sink(),
      sinkAt(3, 5, 2, 2),
      sourceAt(4, 6, 3, 3),
      sinkAt(5, 2, 1, 1, MEDIUM_ELECTRICAL),
      sinkAt(6, 10, 2, 3),
    ];
    const belt30 = echoBelt(30, [
      [9, 0],
      [9, 1],
      [9, 2],
    ]);
    const key = (p: { x: number; y: number }): string => `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`;
    rig = setupRigWith({ cellsFromWorld: true }, ...board());
    rig.scene.belts.set(30, belt30);
    rig.armBelt();
    const rings = rig.overlay.dockTargetCalls.at(-1) ?? [];
    const ringSet = [...new Set(rings.map(key))].sort();
    expect(ringSet, 'NON-VACUITY: the ring set holds an Out, an In, the shared doorstep and a belt Head').toEqual(
      ['3,5', '5,3', '7,5', '9,3'].sort(),
    );
    expect(
      rings.filter((p) => key(p) === '5,3'),
      'the shared doorstep wears TWO concentric rings, read as one',
    ).toHaveLength(2);
    rig.destroy();
    rig = undefined;
    const pressSet: string[] = [];
    for (let cx = 0; cx <= 11; cx++) {
      for (let cy = 0; cy <= 7; cy++) {
        const r = setupRigWith({ cellsFromWorld: true }, ...board());
        try {
          r.scene.belts.set(30, belt30);
          r.armBelt();
          p89Press(r, cx * CELL + 11, cy * CELL + 20);
          if (r.overlay.nubRingCalls.some((c) => c.armed)) {
            pressSet.push(`${cx},${cy}`);
          }
        } finally {
          r.destroy();
        }
      }
    }
    expect(pressSet.sort(), 'the press set equals the ring set, term for term').toEqual(ringSet);

    // The shared doorstep resolves to the OUT (A10): a forward draw, its Tail docked to Source 4.
    rig = setupRigWith({ cellsFromWorld: true }, ...board());
    rig.armBelt();
    p89Press(rig, p89Centre(5, 3).x, p89Centre(5, 3).y);
    p89WalkThrough(rig, [p89Centre(5, 3), p89Centre(5, 4), p89Centre(4, 4)], 6);
    p89Release(rig, p89Centre(4, 4).x, p89Centre(4, 4).y);
    const forward: Array<[number, number]> = [
      [5, 3],
      [5, 4],
      [4, 4],
    ];
    expect(rig.sent.map((f) => [...f]), 'a forward draw from the shared doorstep').toEqual([
      [...encodeGridCommand({ kind: 'DrawBelt', cells: forward })],
    ]);
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, echoBelt(42, forward));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent.slice(1).map((f) => [...f]), 'its Tail docks the Out; nothing docks the In').toEqual([
      [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Tail', node: 4, port: 0 })],
    ]);
  });

  it('a_reversed_preview_matches_the_sent_cells', () => {
    // D-02, UI-SPEC 1.2: a reversed draw's preview is computed from the REVERSED cells, so the tile
    // under the press is the Head and turns INTO the In, and the tile under the hand is the Tail
    // and turns OUT of the Out the hand is on. Pressed on the Sink In's doorstep (7,5), up to row
    // 4, west along it, down onto the Source Out's doorstep (3,5): every drawn sample is sub-cell.
    // The last preview's cells are the sent DrawBelt's cells in order, its end kinds are the
    // joined ones, and the held picture after the release is that same preview.
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    rig.armBelt();
    p89Press(rig, p89Centre(7, 5).x - 3, p89Centre(7, 5).y + 2);
    p89WalkThrough(
      rig,
      [
        { x: p89Centre(7, 5).x - 3, y: p89Centre(7, 5).y + 2 },
        { x: p89Centre(7, 4).x + 2, y: p89Centre(7, 4).y },
        { x: p89Centre(3, 4).x, y: p89Centre(3, 4).y - 3 },
        { x: p89Centre(3, 5).x + 4, y: p89Centre(3, 5).y + 1 },
      ],
      5,
    );
    const preview = rig.overlay.beltCalls.at(-1);
    const sentCells: Array<[number, number]> = [
      [3, 5],
      [3, 4],
      [4, 4],
      [5, 4],
      [6, 4],
      [7, 4],
      [7, 5],
    ];
    p89Release(rig, p89Centre(3, 5).x + 4, p89Centre(3, 5).y + 1);
    console.log(
      `P89-BELT-01-preview cells=${JSON.stringify((preview?.tiles ?? []).map((t) => [t.cell_x, t.cell_y]))} kinds=${JSON.stringify((preview?.tiles ?? []).map((t) => t.kind))}`,
    );
    expect(rig.sent.map((f) => [...f]), 'ONE DrawBelt, Tail at the Out doorstep, Head at the pressed In doorstep').toEqual([
      [...encodeGridCommand({ kind: 'DrawBelt', cells: sentCells })],
    ]);
    expect(preview?.valid, 'the last preview was blue').toBe(true);
    expect(
      (preview?.tiles ?? []).map((t) => [t.cell_x, t.cell_y]),
      'the last preview painted exactly the sent cells, in the sent order',
    ).toEqual(sentCells);
    const kinds = (preview?.tiles ?? []).map((t) => t.kind);
    expect(kinds[0], 'the Tail tile turns out of the E-facing Out, north: Corner{E,N}').toEqual({
      Corner: { from: 1, to: 0 },
    });
    expect(kinds[kinds.length - 1], 'the Head tile turns south into the W-facing In, east: Corner{S,E}').toEqual({
      Corner: { from: 2, to: 1 },
    });
    expect(rig.overlay.heldBelts.pictures, 'the held picture is the last preview, tile for tile').toEqual([preview?.tiles]);
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, echoBelt(42, sentCells));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent.slice(1).map((f) => [...f]), 'the Tail docks the Out and the Head docks the pressed In').toEqual(
      p89OwedDocks(),
    );
  });

  it(
    'a_release_inside_an_in_dot_over_the_machine_edge_docks',
    () => {
      // BELT-03 (D-03): the Sink's In dot straddles its W edge (world x 256). A hand's last sample
      // lands 4 world px inside that edge: inside the dot and inside the Sink's own cell (8,5). The
      // path stops at the doorstep, ONE DrawBelt is sent, and the Head docks to that In.
      rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
      rig.armBelt();
      const inside = { x: 8 * CELL + 4, y: inNub.y };
      rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atPx(outDoor.x, outDoor.y) });
      p89Walk(rig, outDoor.x + 6, inside.x, inside.y, 6);
      const preview = rig.overlay.beltCalls.at(-1);
      rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atPx(inside.x, inside.y) });
      const drawn = rig.sent.map((f) => [...f]);
      if (drawIds(rig).length > 0) {
        acceptDraw(rig, 42);
      }
      rig.scene.belts.set(42, echoBelt(42, portToPortCells));
      rig.flushRaf();
      rig.flushRaf();
      console.log(
        `P89-BELT-03 last_preview_valid=${String(preview?.valid)} last_preview_cells=${JSON.stringify((preview?.tiles ?? []).map((t) => [t.cell_x, t.cell_y]))} drawn=${JSON.stringify(drawn)}`,
      );
      expect(preview?.valid, 'the last preview before the release is build-blue').toBe(true);
      expect(drawn, "ONE DrawBelt, without the Sink's own cell").toEqual([
        [...encodeGridCommand({ kind: 'DrawBelt', cells: portToPortCells })],
      ]);
      expect(rig.sent.slice(1).map((f) => [...f]), 'the Tail and the Head Docks').toEqual(p89OwedDocks());
    },
  );

  it(
    'a_near_miss_on_a_neighbours_in_dot_docks_the_in_the_head_faces',
    () => {
      // W249 (D-04): a 1x1 machine at (7,4) has an ELECTRICAL In on its S edge, its dot on the top
      // edge of (7,5). The draw ends on (7,5), the Sink In's doorstep, and is released inside that
      // electrical dot and outside the Sink's. No hit accepts, so the one auto-dock candidate the
      // head faces, the Sink's In, takes the Head; nothing flashes and nothing is refused.
      const wired = node({
        id: 3,
        kind: machine_kind.SINK,
        cell_x: 7,
        cell_y: 4,
        ports: [{ index: 0, cell_x: 7, cell_y: 4, side: 2, role: 0, medium: MEDIUM_ELECTRICAL }],
      });
      rig = setupRigWith({ cellsFromWorld: true }, source(), sink(), wired);
      rig.armBelt();
      const wiredNub = nubAnchor(7, 4, 2);
      const release = { x: wiredNub.x + 3, y: wiredNub.y + 3.5 };
      rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atPx(outDoor.x, outDoor.y) });
      p89Walk(rig, outDoor.x + 6, 7 * CELL + CELL / 2, outDoor.y, 6);
      rig.win.fire('pointermove', { target: rig.canvas, ...atPx(release.x, release.y) });
      rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atPx(release.x, release.y) });
      const drawn = rig.sent.map((f) => [...f]);
      if (drawIds(rig).length > 0) {
        acceptDraw(rig, 42);
      }
      rig.scene.belts.set(42, echoBelt(42, portToPortCells));
      rig.flushRaf();
      rig.flushRaf();
      const flashes = rig.overlay.rejectFlashCalls.map((c) => c.cell);
      console.log(
        `P89-W249 release=${JSON.stringify(release)} wired_nub=${JSON.stringify(wiredNub)} in_nub=${JSON.stringify(inNub)} drawn=${JSON.stringify(drawn)} docks=${JSON.stringify(rig.sent.slice(1).map((f) => [...f]))} flashes=${JSON.stringify(flashes)}`,
      );
      expect(drawn, 'PRECONDITION: one DrawBelt ending on the Sink In doorstep').toEqual([
        [...encodeGridCommand({ kind: 'DrawBelt', cells: portToPortCells })],
      ]);
      expect(rig.sent.slice(1).map((f) => [...f]), "the Head docks the Sink's In, the In the head faces").toEqual(
        p89OwedDocks(),
      );
      expect(flashes, 'no flash: nothing was refused').toEqual([]);
    },
  );

  // ---------------------------------------------------------------------------
  // Phase 89, plan 89-05 (D-03, D-04, UI-SPEC 1.3 and A22): the release on the dot
  // ---------------------------------------------------------------------------

  it('a_release_inside_an_in_dot_at_half_zoom_docks', () => {
    // D-03 at camera scale 0.5, where the hit radius is 24 world px and reaches deeper into the
    // machine. The hand's last sample is 4 world px inside the Sink's W edge (its own cell (8,5)),
    // every sample sub-cell; the walk pushed (8,5), the trim drops it, the preview is blue, and the
    // release sends ONE DrawBelt without the Sink's cell and the Tail and Head Docks.
    const k = 0.5;
    rig = setupRigWith({ cellsFromWorld: true, scale: k }, source(), sink());
    rig.armBelt();
    const inside = { x: 8 * CELL + 4, y: inNub.y + 2 };
    p89Press(rig, outDoor.x * k, outDoor.y * k);
    p89WalkThrough(
      rig,
      [
        { x: outDoor.x * k, y: outDoor.y * k },
        { x: inside.x * k, y: inside.y * k },
      ],
      3,
    );
    const preview = rig.overlay.beltCalls.at(-1);
    p89Release(rig, inside.x * k, inside.y * k);
    expect(
      (preview?.tiles ?? []).map((t) => [t.cell_x, t.cell_y]),
      "the last preview stops at the doorstep: the Sink's own cell was trimmed",
    ).toEqual(portToPortCells);
    expect(preview?.valid, 'and it is blue').toBe(true);
    expect(rig.sent.map((f) => [...f]), "ONE DrawBelt, without the Sink's own cell").toEqual([
      [...encodeGridCommand({ kind: 'DrawBelt', cells: portToPortCells })],
    ]);
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, echoBelt(42, portToPortCells));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent.slice(1).map((f) => [...f]), 'the Tail and the Head Docks').toEqual(p89OwedDocks());
  });

  it('a_path_that_crosses_a_machine_before_the_head_stays_red', () => {
    // The trim drops only the TARGET's own cells at the HEAD (the plan's prohibition). A machine
    // at (5,5) on the row: a drag from the Out doorstep across it, released inside the Sink's dot
    // over its edge, keeps the crossed cell (5,5), so the preview stays red and nothing is sent;
    // only the Sink's own trailing cell (8,5) is dropped. Released in the doorstep half of the dot
    // (nothing to trim), the crossing is red the same way.
    const block = node({ id: 9, cell_x: 5, cell_y: 5 });
    for (const releaseX of [8 * CELL + 4, 8 * CELL - 4]) {
      const r = setupRigWith({ cellsFromWorld: true }, source(), block, sink());
      try {
        r.armBelt();
        p89Press(r, outDoor.x, outDoor.y);
        p89WalkThrough(
          r,
          [
            { x: outDoor.x, y: outDoor.y },
            { x: releaseX, y: inNub.y - 1 },
          ],
          5,
        );
        const preview = r.overlay.beltCalls.at(-1);
        p89Release(r, releaseX, inNub.y - 1);
        expect(
          (preview?.tiles ?? []).map((t) => [t.cell_x, t.cell_y]),
          `release at x=${releaseX}: the crossed machine cell (5,5) is kept; only the Sink's own cell may go`,
        ).toEqual(portToPortCells);
        expect(preview?.valid, `release at x=${releaseX}: the crossing is red`).toBe(false);
        // Since plan 89-09 (D-13) a red path is sent as the preview painted it, with no claim,
        // and the one flash is the crossed machine cell (D-12).
        const frame = expectIllegalDrawSent(r, `release at x=${releaseX}`);
        expect([...frame], `release at x=${releaseX}: the cells sent are the previewed ones`).toEqual([
          ...encodeGridCommand({ kind: 'DrawBelt', cells: portToPortCells }),
        ]);
        expect(r.overlay.rejectFlashCalls.map((c) => c.cell), `release at x=${releaseX}: ONE flash, on the crossed cell`).toEqual([
          { cx: 5, cy: 5 },
        ]);
      } finally {
        r.destroy();
      }
    }
  });

  it('a_reversed_release_inside_an_out_dot_trims_and_docks', () => {
    // UI-SPEC A22: the dot rule both ways. A draw pressed on the Sink In's doorstep (7,5) and
    // released 4 world px inside the Source's E edge (its own cell (2,5), inside its Out dot): the
    // walk pushed (2,5), the trim drops it, so the Tail lands on the Out's doorstep (3,5). The
    // preview is blue, ONE DrawBelt is sent reversed, then the Tail and the Head Docks.
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    rig.armBelt();
    const inside = { x: 3 * CELL - 4, y: outNub.y + 2 };
    p89Press(rig, p89Centre(7, 5).x, p89Centre(7, 5).y);
    p89WalkThrough(rig, [p89Centre(7, 5), inside], 5);
    const preview = rig.overlay.beltCalls.at(-1);
    p89Release(rig, inside.x, inside.y);
    expect(
      (preview?.tiles ?? []).map((t) => [t.cell_x, t.cell_y]),
      "the last preview starts on the Out's doorstep: the Source's own cell was trimmed",
    ).toEqual(portToPortCells);
    expect(preview?.valid, 'and it is blue').toBe(true);
    expect(rig.sent.map((f) => [...f]), 'ONE DrawBelt, Tail at the Out doorstep').toEqual([
      [...encodeGridCommand({ kind: 'DrawBelt', cells: portToPortCells })],
    ]);
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, echoBelt(42, portToPortCells));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent.slice(1).map((f) => [...f]), 'the Tail docks the Out and the Head docks the pressed In').toEqual(
      p89OwedDocks(),
    );
  });

  it('a_reversed_release_on_a_refused_out_dot_flashes_that_dot', () => {
    // Review IN-B-04 (UI-SPEC A22, A23): the reversed draw follows the forward rules, the WHERE
    // half too. A draw pressed on the Sink In's doorstep (7,5) and released on the doorstep of an
    // ELECTRICAL Source Out, 4 world px from its dot: the Out is the last-resort Tail the host
    // refuses (a belt is Mechanical), so the release flashes the dot's cell (2,5), as the forward
    // draw flashes a refused In's dot (WR-02 end above). Red before the fix: no flash.
    const electricSource = node({
      id: 1,
      kind: machine_kind.SOURCE,
      cell_x: 2,
      cell_y: 5,
      ports: [{ index: 0, cell_x: 2, cell_y: 5, side: 1, role: 1, medium: 1 }],
    });
    rig = setupRigWith({ cellsFromWorld: true }, electricSource, sink());
    rig.armBelt();
    const at = { x: outNub.x + 4, y: outNub.y + 1 };
    p89Press(rig, p89Centre(7, 5).x, p89Centre(7, 5).y);
    p89WalkThrough(rig, [p89Centre(7, 5), at], 5);
    p89Release(rig, at.x, at.y);
    expect(rig.sent.length, 'NON-VACUITY: the DrawBelt went out').toBeGreaterThan(0);
    expect(rig.overlay.rejectFlashCalls.map((c) => c.cell), 'ONE flash, on the refused Out dot cell').toEqual([{ cx: 2, cy: 5 }]);
  });

  it('the_preview_and_the_release_read_one_answer', () => {
    // Research Pitfall 5, T-89-14: a sweep of release points over and around the Sink's In dot,
    // both halves (doorstep and machine), each reached by sub-cell samples and released where the
    // last sample was. At every point: when the last preview was blue, the release sends exactly
    // its cells and pictures exactly its tiles (cells and kinds, so the docked ends too); when it
    // was red, its cells are sent with no claim and no picture (plan 89-09, D-13). NON-VACUITY: some points are inside the Sink, and every point
    // inside the dot's 12 px hit radius is blue (the trim at work); a point inside the Sink but
    // outside the dot is red, as a hand on the machine body is.
    let trimmed = 0;
    let blue = 0;
    let red = 0;
    let redInDot = 0;
    let redOnSinkBody = 0;
    for (let dx = -14; dx <= 14; dx += 2) {
      for (let dy = -10; dy <= 10; dy += 5) {
        const at = { x: inNub.x + dx, y: inNub.y + dy };
        const r = setupRigWith({ cellsFromWorld: true }, source(), sink());
        try {
          r.armBelt();
          p89Press(r, outDoor.x, outDoor.y);
          p89WalkThrough(r, [outDoor, at], 5);
          const preview = r.overlay.beltCalls.at(-1);
          p89Release(r, at.x, at.y);
          if (Math.floor(at.x / CELL) === 8) {
            trimmed += 1;
          }
          if (preview?.valid) {
            blue += 1;
            const cells = (preview.tiles ?? []).map((t) => [t.cell_x, t.cell_y] as [number, number]);
            expect(r.sent.map((f) => [...f]), `release at ${JSON.stringify(at)}: the sent cells are the previewed ones`).toEqual([
              [...encodeGridCommand({ kind: 'DrawBelt', cells })],
            ]);
            expect(r.overlay.heldBelts.pictures, `release at ${JSON.stringify(at)}: the held picture is the last preview`).toEqual([
              preview.tiles,
            ]);
          } else {
            red += 1;
            if (Math.hypot(dx, dy) <= nubHitRadiusWorld(1)) {
              redInDot += 1;
            } else if (Math.floor(at.x / CELL) === 8) {
              redOnSinkBody += 1;
            }
            // Since plan 89-09 (D-13) a red preview is SENT, exactly its cells, with no claim and
            // no held picture, so the host says why.
            const frame = expectIllegalDrawSent(r, `release at ${JSON.stringify(at)}`);
            if ((preview?.tiles ?? []).length > 0) {
              const cells = (preview?.tiles ?? []).map((t) => [t.cell_x, t.cell_y] as [number, number]);
              expect([...frame], `release at ${JSON.stringify(at)}: a red preview sends the previewed cells`).toEqual([
                ...encodeGridCommand({ kind: 'DrawBelt', cells }),
              ]);
            }
          }
        } finally {
          r.destroy();
        }
      }
    }
    console.log(
      `P89-ONE-ANSWER points=${blue + red} blue=${blue} red=${red} red_in_dot=${redInDot} red_on_sink_body=${redOnSinkBody} inside_the_sink=${trimmed}`,
    );
    expect(trimmed, 'NON-VACUITY: the sweep reaches inside the Sink').toBeGreaterThan(0);
    expect(redInDot, 'every point inside the dot is a blue, sent belt').toBe(0);
    // The red half of the claim above, asserted (review IN-C-10): a point inside the Sink but
    // outside the dot's hit radius previews red, as a hand on the machine body does.
    expect(redOnSinkBody, 'NON-VACUITY: a point inside the Sink, outside the dot, previews red').toBeGreaterThan(0);
  });

  it(
    'an_illegal_path_released_on_an_electrical_in_flashes_the_path_not_the_nub',
    () => {
      // W250 (D-12): the path crosses a machine at (5,5) and is released on an ELECTRICAL In's dot.
      // The path verdict comes first: the one flash lands on the first offending cell (5,5), never
      // on the nub cell (8,5) of a port the host was never asked about.
      const block = node({ id: 9, cell_x: 5, cell_y: 5 });
      const wiredSink = node({
        id: 2,
        kind: machine_kind.SINK,
        cell_x: 8,
        cell_y: 5,
        ports: [{ index: 0, cell_x: 8, cell_y: 5, side: 3, role: 0, medium: MEDIUM_ELECTRICAL }],
      });
      rig = setupRigWith({ cellsFromWorld: true }, source(), block, wiredSink);
      rig.armBelt();
      rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atPx(outDoor.x, outDoor.y) });
      p89Walk(rig, outDoor.x + 6, inNub.x, inNub.y, 6);
      rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atPx(inNub.x, inNub.y) });
      const flashes = rig.overlay.rejectFlashCalls.map((c) => c.cell);
      console.log(`P89-W250 flashes=${JSON.stringify(flashes)} sent=${JSON.stringify(rig.sent.map((f) => [...f]))}`);
      expect(flashes, 'ONE flash, on the first machine cell the path crosses').toEqual([{ cx: 5, cy: 5 }]);
    },
  );

  it(
    'a_dock_owed_and_never_sent_is_reported',
    () => {
      // W254 (D-14): a docked draw is accepted in the table of an Undo's keyframe (generation 1)
      // that removed the Sink. Its owed Head Dock cannot be named again in that table and is
      // dropped; the drop must say so in a client sentence, `DockNotSent`.
      rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
      rig.armBelt();
      rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atPx(outDoor.x, outDoor.y) });
      p89Walk(rig, outDoor.x + 6, inNub.x, inNub.y, 6);
      rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atPx(inNub.x, inNub.y) });
      const src0 = rig.scene.nodes.get(1)!;
      rig.scene.nodes.clear();
      rig.scene.nodes.set(5, { ...src0, id: 5 });
      rig.scene.generation = 1;
      rig.clearSel();
      if (drawIds(rig).length > 0) {
        acceptDraw(rig, 42, -1, 1);
      }
      rig.scene.belts.set(42, echoBelt(42, portToPortCells));
      rig.flushRaf();
      rig.flushRaf();
      const refusals = rig.clientRefusals as string[];
      console.log(`P89-W254 docks=${JSON.stringify(rig.sent.slice(1).map((f) => [...f]))} client_refusals=${JSON.stringify(refusals)}`);
      expect(rig.sent.slice(1).map((f) => [...f]), 'PRECONDITION: only the Tail Dock could be named and went out').toEqual([
        [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Tail', node: 5, port: 0 })],
      ]);
      expect(refusals, 'the owed Head Dock that was never sent is reported').toContain('DockNotSent');
    },
  );

  it('a_legal_path_onto_an_electrical_in_flashes_the_nub', () => {
    // UI-SPEC 6.2 row 4 (plan 89-09, D-12): a LEGAL path released on an Electrical In's dot sends
    // its DrawBelt with its claim (the Head dock is sent and the host answers MediumMismatch), and
    // the one flash is the dot's cell, the port the host will refuse (WR-02).
    const wiredSink = node({
      id: 2,
      kind: machine_kind.SINK,
      cell_x: 8,
      cell_y: 5,
      ports: [{ index: 0, cell_x: 8, cell_y: 5, side: 3, role: 0, medium: MEDIUM_ELECTRICAL }],
    });
    rig = setupRigWith({ cellsFromWorld: true }, source(), wiredSink);
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atPx(outDoor.x, outDoor.y) });
    p89Walk(rig, outDoor.x + 6, inNub.x, inNub.y, 6);
    expect(rig.overlay.beltCalls.at(-1)?.valid, 'NON-VACUITY: the path is legal').toBe(true);
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atPx(inNub.x, inNub.y) });
    expect(drawIds(rig), 'ONE DrawBelt').toHaveLength(1);
    expect(rig.sentClaims[0], 'a legal send carries its claim').toBeDefined();
    expect(rig.overlay.rejectFlashCalls.map((c) => c.cell), 'ONE flash, on the dot cell').toEqual([{ cx: 8, cy: 5 }]);
  });

  /** A docked draw from the Source's Out doorstep to the Sink's In dot, released. */
  const p89DockedDraw = (r: Rig): void => {
    r.armBelt();
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...atPx(outDoor.x, outDoor.y) });
    p89Walk(r, outDoor.x + 6, inNub.x, inNub.y, 6);
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...atPx(inNub.x, inNub.y) });
  };

  it('dock_not_sent_on_the_lost_verdict_fallback', () => {
    // D-14 site 2 (plan 89-09): a docked draw whose verdict never comes. Past ECHO_TTL_TICKS
    // playing ticks the fallback drops the entry with its two Docks unsent, and says so. The
    // control: an undocked draw (floor to floor) dropped the same way owed nothing and is silent.
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    p89DockedDraw(rig);
    expect(rig.waiting().belts, 'NON-VACUITY: the belt waits with its Docks owed').toBe(1);
    rig.scene.tick = 121;
    rig.flushRaf();
    expect(rig.waiting().belts, 'the fallback dropped it').toBe(0);
    expect(rig.sent.filter((f) => f[0] === 4), 'no Dock was sent').toEqual([]);
    expect(rig.clientRefusals, 'the dropped Docks are reported').toEqual(['DockNotSent']);

    rig.destroy();
    rig = setupRigWith({ cellsFromWorld: true });
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atPx(2 * CELL + 16, 9 * CELL + 16) });
    p89Walk(rig, 2 * CELL + 22, 6 * CELL + 16, 9 * CELL + 16, 6);
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atPx(6 * CELL + 16, 9 * CELL + 16) });
    expect(rig.waiting().belts, 'NON-VACUITY: the undocked belt waits').toBe(1);
    rig.scene.tick = 121;
    rig.flushRaf();
    expect(rig.waiting().belts, 'the fallback dropped it').toBe(0);
    expect(rig.clientRefusals, 'an undocked draw owed nothing and says nothing').toEqual([]);
  });

  it('dock_not_sent_when_the_accept_names_no_belt', () => {
    // D-14 site 3 (plan 89-09): the host accepts the DrawBelt but names no minted belt, so the owed
    // Docks have nothing to address. The entry ends with nothing sent, and the client says so.
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    p89DockedDraw(rig);
    rig.accept(drawIds(rig)[0], [], 0);
    rig.flushRaf();
    expect(rig.waiting().belts, 'the entry ended').toBe(0);
    expect(rig.sent.filter((f) => f[0] === 4), 'no Dock was sent').toEqual([]);
    expect(rig.clientRefusals, 'the dropped Docks are reported').toEqual(['DockNotSent']);
  });

  it('the_swap_floor_drop_is_silent', () => {
    // Pitfall 10 (plan 89-09): an accept written on a board a Load replaced (the scene's swap
    // floor 2 is above the accept's generation 1). Nothing is owed on the loaded board, so the
    // drop sends nothing and says nothing.
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    p89DockedDraw(rig);
    acceptDraw(rig, 42, -1, 1);
    expect(rig.waiting().belts, 'NON-VACUITY: the belt is held with its Docks owed').toBe(1);
    rig.scene.nodes.clear();
    rig.scene.belts.clear();
    rig.scene.generation = 2;
    rig.scene.swapFloor = 2;
    rig.clearSel();
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.waiting().belts, 'the entry ended').toBe(0);
    expect(rig.sent.filter((f) => f[0] === 4), 'no Dock was sent').toEqual([]);
    expect(rig.clientRefusals, 'and nothing is said').toEqual([]);
  });

  it('the_belt_gone_drop_is_silent', () => {
    // Pitfall 10 (plan 89-09): accepted in generation 1 for a draw made on generation 0, and the
    // newest table (generation 2, no swap) holds no belt on the drawn cells: a later edit took the
    // belt away, so no Dock is owed to it. Nothing is sent and nothing is said.
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    p89DockedDraw(rig);
    acceptDraw(rig, 42, -1, 1);
    expect(rig.waiting().belts, 'NON-VACUITY: the belt is held with its Docks owed').toBe(1);
    rig.scene.belts.clear();
    rig.scene.generation = 2;
    rig.clearSel();
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.waiting().belts, 'the entry ended').toBe(0);
    expect(rig.sent.filter((f) => f[0] === 4), 'no Dock was sent').toEqual([]);
    expect(rig.clientRefusals, 'and nothing is said').toEqual([]);
  });

  it(
    'a_press_just_inside_a_machine_edge_sends_its_draw_belt',
    () => {
      // FAIL-02 (D-13): a press 2 world px inside the Source's E edge (in its own cell (2,5)) and a
      // drag of about 80 world px east in 4 px samples is SENT, so the host can say why nothing
      // was built; the one flash names the pressed cell.
      rig = setupRigWith({ cellsFromWorld: true }, source());
      rig.armBelt();
      const y = outDoor.y;
      rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atPx(3 * CELL - 2, y) });
      p89Walk(rig, 3 * CELL + 2, 3 * CELL + 78, y, 4);
      rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atPx(3 * CELL + 78, y) });
      const flashes = rig.overlay.rejectFlashCalls.map((c) => c.cell);
      console.log(`P89-FAIL-02-edge sent=${JSON.stringify(rig.sent.map((f) => [...f]))} flashes=${JSON.stringify(flashes)}`);
      expect(rig.sent.map((f) => [...f]), 'ONE DrawBelt from the pressed machine cell').toEqual([
        [
          ...encodeGridCommand({
            kind: 'DrawBelt',
            cells: [
              [2, 5],
              [3, 5],
              [4, 5],
              [5, 5],
            ],
          }),
        ],
      ]);
      expect(flashes, 'ONE flash, on the pressed cell').toEqual([{ cx: 2, cy: 5 }]);
    },
  );

  it('a_predicted_illegal_send_arms_no_picture_no_claim_no_seam_and_no_docks', () => {
    // D-13, UI-SPEC 6.3 (plan 89-09): a docked draw from the Source's Out to the Sink's In that
    // crosses a machine at (5,5). The release is SENT, the cells the preview painted, but as a
    // predicted-illegal send it carries no claim, arms no held picture, records no predicted
    // seam, and owes no Dock: even if the host accepted it, no Dock would follow. The start ring
    // is cleared and the preview too.
    rig = setupRigWith({ cellsFromWorld: true }, source(), node({ id: 9, cell_x: 5, cell_y: 5 }), sink());
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atPx(outDoor.x, outDoor.y) });
    p89Walk(rig, outDoor.x + 6, inNub.x, inNub.y, 6);
    expect(rig.overlay.beltCalls.at(-1)?.valid, 'NON-VACUITY: the preview is red').toBe(false);
    const rings = rig.overlay.nubRingCleared.count;
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atPx(inNub.x, inNub.y) });
    const frame = expectIllegalDrawSent(rig, 'the docked draw across a machine');
    expect([...frame], 'the cells the preview painted').toEqual([...encodeGridCommand({ kind: 'DrawBelt', cells: portToPortCells })]);
    expect(rig.sentClaims, 'no claim on any frame').toEqual([undefined]);
    expect(pendingSeamsRecords(), 'no predicted seam').toEqual([]);
    expect(rig.overlay.beltPreview.on, 'the preview is cleared at the release').toBe(false);
    expect(rig.overlay.nubRingCleared.count, 'the start ring is cleared').toBeGreaterThan(rings);
    // Were the host to accept it anyway, the belt lands undocked: no Dock is owed.
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, echoBelt(42, portToPortCells));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent.filter((f) => f[0] === 4), 'and no Dock follows').toEqual([]);
    expect(rig.overlay.heldBelts.pictures, 'and no picture ever shows').toEqual([]);
  });

  it('a_toolbar_pointerup_with_no_draw_sends_nothing', () => {
    // Pitfall 9 (plan 89-09): every release WITH cells is sent now, so the one release that must
    // still send nothing is a pointerup with no draw in progress, a click on the toolbar's Play
    // button with the Belt tool armed. It sends nothing, flashes nothing and keeps the tool.
    rig = setupRigWith({ cellsFromWorld: true }, source());
    rig.armBelt();
    rig.win.fire('pointerup', { button: 0, target: {}, ...atPx(outDoor.x, outDoor.y) });
    expect(rig.sent, 'nothing is sent').toHaveLength(0);
    expect(rig.overlay.rejectFlashCalls, 'nothing flashes').toEqual([]);
    expect(rig.armedCalls.at(-1), 'the tool stays armed').toEqual({ kind: 'belt' });
    // NON-VACUITY: a real draw on the same rig is still sent.
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atPx(outDoor.x, outDoor.y) });
    p89Walk(rig, outDoor.x + 6, inNub.x, inNub.y, 6);
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atPx(inNub.x, inNub.y) });
    expect(drawIds(rig), 'NON-VACUITY: the draw after it is sent').toHaveLength(1);
  });

  it('a_legal_release_with_accepted_docks_flashes_nothing', () => {
    // UI-SPEC 6.2's last row (plan 89-09): a legal path whose docks the mirror accepts, the
    // Source's Out to the Sink's In, flashes nothing and is sent with its claim and its picture.
    rig = setupRigWith({ cellsFromWorld: true }, source(), sink());
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atPx(outDoor.x, outDoor.y) });
    p89Walk(rig, outDoor.x + 6, inNub.x, inNub.y, 6);
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atPx(inNub.x, inNub.y) });
    expect(rig.sent.map((f) => [...f]), 'ONE DrawBelt').toEqual([[...encodeGridCommand({ kind: 'DrawBelt', cells: portToPortCells })]]);
    expect(rig.sentClaims[0], 'a legal send carries its claim').toBeDefined();
    expect(rig.overlay.heldBelts.pictures, 'and its held picture').toHaveLength(1);
    expect(rig.overlay.rejectFlashCalls, 'and nothing flashes').toEqual([]);
  });
});

// Phase 30-03 (IX-01/02/03/05/06/08): machine placement is unified onto the
// Belt tool's persistent arm-then-act mechanic. Arming emits nothing and sets a
// crosshair cursor + reports the armed tool via onArmedChange; a legal canvas
// click emits exactly ONE Place, shows the NEUTRAL pending shimmer (never the
// false-success blue persist), and STAYS ARMED for repeat placement; an illegal
// click emits nothing and fires a one-shot reject flash while staying armed;
// Esc / right-click / re-clicking the tool all disarm (cursor cleared, pan
// restored, onArmedChange(null)). These units pin the state machine on the
// existing GPU-free harness.
describe('Persistent-arm placement machine (IX-01/03/05/06)', () => {
  /** Arm a SOURCE and move the cursor onto the canvas floor at (cx, cy). */
  const armAndHover = (r: Rig, cx: number, cy: number): void => {
    r.begin(machine_kind.SOURCE);
    r.win.fire('pointermove', { target: r.canvas, ...at(cx, cy) });
  };

  /** A click-to-place: canvas pointerdown then window pointerup (no drag). */
  const clickPlace = (r: Rig, cx: number, cy: number): void => {
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...at(cx, cy) });
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...at(cx, cy) });
  };

  /** The exact Place frame bytes, for FULL sent-list equality assertions. */
  const placeFrame = (kind: number, cx: number, cy: number): number[] => [
    ...encodeGridCommand({ kind: 'Place', kind_byte: kind, cell_x: cx, cell_y: cy }),
  ];

  it('arming sets a crosshair cursor, suspends pan, and reports the armed machine (IX-03)', () => {
    rig = setupRig();
    rig.begin(machine_kind.SOURCE);
    expect(rig.cursor()).toBe('crosshair');
    expect(rig.panState.enabled).toBe(false);
    expect(rig.armedCalls).toEqual([{ kind: 'machine', machineKind: machine_kind.SOURCE }]);
  });

  it('a plain move over the canvas follows the ghost and emits nothing while armed (IX-01)', () => {
    rig = setupRig();
    armAndHover(rig, 5, 5);
    // The ghost re-rendered at the hovered cell; no command emitted by arming/moving.
    expect(rig.overlay.ghostCalls.length).toBeGreaterThan(0);
    expect(rig.overlay.ghostCalls.at(-1)?.valid).toBe(true);
    expect(rig.sent).toHaveLength(0);
  });

  it('a legal click emits exactly one Place, shows the neutral pending shimmer, and STAYS ARMED (IX-05/06)', () => {
    rig = setupRig();
    armAndHover(rig, 5, 5);

    clickPlace(rig, 5, 5);

    // Exactly one Place (byte-identical, no optimistic scene write).
    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({
        kind: 'Place',
        kind_byte: machine_kind.SOURCE,
        cell_x: 5,
        cell_y: 5,
      }),
    ]);
    // IX-05 honesty: the pending shimmer is shown at the placed cell, NOT a
    // persisted build-blue ghost.
    expect(rig.overlay.pendingCalls).toHaveLength(1);
    expect(rig.overlay.pendingCalls[0].cell).toEqual({ cx: 5, cy: 5 });
    // IX-06 stays armed: the cursor is still crosshair and the tool never disarmed.
    expect(rig.cursor()).toBe('crosshair');
    expect(rig.armedCalls).toEqual([{ kind: 'machine', machineKind: machine_kind.SOURCE }]);

    // A SECOND legal click places again — proving the tool stayed in hand.
    rig.win.fire('pointermove', { target: rig.canvas, ...at(7, 7) });
    clickPlace(rig, 7, 7);
    expect(rig.sent).toHaveLength(2);
    expect([...rig.sent[1]]).toEqual([
      ...encodeGridCommand({
        kind: 'Place',
        kind_byte: machine_kind.SOURCE,
        cell_x: 7,
        cell_y: 7,
      }),
    ]);
  });

  it('a click the ghost predicts illegal STILL asks the host, flashes, and stays armed (IX-05 + D-07)', () => {
    // SUPERSEDED BEHAVIOUR, QUOTED RATHER THAN DELETED (plan 64-06, suppression
    // site 1 of 6). This case used to assert `rig.sent` had length 0 - "an
    // illegal click emits nothing (NEVER a false success)". That reading was
    // right about false success and wrong about silence: because the client
    // returned early, the host was never asked, no verdict ever came back, and
    // the user got a dead click with no explanation. Phase 64 demotes the
    // ghost's verdict from GATE to ADVISORY (D-07): what the player sees is what
    // the host is asked, and the host's typed refusal becomes a sentence on
    // screen. The false-success guarantee is UNCHANGED and is enforced where it
    // always really lived - no local scene write, and the neutral pending
    // shimmer rather than a build-blue "placed" ghost.
    //
    // A machine already occupies (5,5): the ghost predicts the click illegal.
    rig = setupRig(node({ id: 9, cell_x: 5, cell_y: 5 }));
    armAndHover(rig, 5, 5);
    expect(rig.overlay.ghostCalls.at(-1)?.valid).toBe(false);

    clickPlace(rig, 5, 5);

    // The command IS emitted: the host is the authority on whether it stands.
    // Assert the FULL frame list, not just the count. A count check was what
    // this test used to make, and it is blind by construction to the defect
    // below: extra frames aimed at the BLOCKING node rode the same pointerup.
    expect(rig.sent.map((b) => [...b])).toEqual([placeFrame(machine_kind.SOURCE, 5, 5)]);
    // The optimistic WHERE cue still fires over the attempted footprint - it is
    // the other half of the feedback rule and it never carries a reason.
    expect(rig.overlay.rejectFlashCalls).toHaveLength(1);
    expect(rig.overlay.rejectFlashCalls[0].cell).toEqual({ cx: 5, cy: 5 });
    // IX-05 honesty holds on the refused path too: the NEUTRAL pending shimmer
    // marks the attempted cell while the host's answer is outstanding.
    expect(rig.overlay.pendingCalls).toHaveLength(1);
    expect(rig.overlay.pendingCalls[0].cell).toEqual({ cx: 5, cy: 5 });
    // Draining the echo watcher must never adopt node 9 as this Place's echo.
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent.map((b) => [...b])).toEqual([placeFrame(machine_kind.SOURCE, 5, 5)]);
    // Still armed: a legal click on a free cell then emits a second Place.
    rig.win.fire('pointermove', { target: rig.canvas, ...at(8, 8) });
    clickPlace(rig, 8, 8);
    expect(rig.sent.map((b) => [...b])).toEqual([
      placeFrame(machine_kind.SOURCE, 5, 5),
      placeFrame(machine_kind.SOURCE, 8, 8),
    ]);
  });

  // The refused-Place bystander defects. `finishPlacement` stopped returning on
  // `!valid` (the point of Phase 64 - ask the host instead of swallowing the
  // gesture), but the echo watcher was left alone. It resolved a pending
  // placement on "is there a node at this cell", and on a refused Place the cell
  // holds a node precisely BECAUSE the placement was refused. The pre-existing
  // machine was adopted as "my Place echoed" on the SAME pointerup, and every
  // follow-up the placement had queued fired at it. Both cases below are
  // reachable from the shipped palette in one click.
  it('a refused Place NEVER rotates the machine that blocked it', () => {
    // Ghost rot 1 (one `r`), then a click on the cell node 9 occupies. The
    // queued Rotate used to go out as `Rotate{node:9}`: the bystander turned 90
    // degrees, its ports moved, and its docked belts broke - while the only
    // message on screen said the placement was refused.
    rig = setupRig(node({ id: 9, cell_x: 5, cell_y: 5 }));
    rig.begin(machine_kind.SOURCE);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(5, 5) });
    rig.win.fire('keydown', { key: 'r', shiftKey: false, preventDefault: () => {} });
    expect(rig.overlay.ghostCalls.at(-1)?.dims?.rot).toBe(1);

    clickPlace(rig, 5, 5);
    // The host refuses it (phase 88: the refusal ends the entry, nothing is sent).
    rig.refuse(1, 'FootprintCollision');
    rig.flushRaf();
    rig.flushRaf();

    // Exactly the Place, and nothing addressed at node 9.
    expect(rig.sent.map((b) => [...b])).toEqual([placeFrame(machine_kind.SOURCE, 5, 5)]);
  });

  it('a refused Router-preset Place NEVER re-ports the machine that blocked it', () => {
    // The Router preset seeds its typed ports on echo (ROUTE-06): strip the bare
    // catalog ports, then AddPort the 1-in/2-out legs. Aimed at the BLOCKING
    // node that is a silent, unlogged-to-the-user teardown - node 9's entire
    // port list deleted and reseeded, undocking every belt on it.
    rig = setupRig(
      node({
        id: 9,
        cell_x: 5,
        cell_y: 5,
        ports: [
          { index: 0, cell_x: 5, cell_y: 5, side: 3, role: 0, medium: MEDIUM_MECHANICAL },
          { index: 1, cell_x: 5, cell_y: 5, side: 1, role: 1, medium: MEDIUM_MECHANICAL },
        ],
      }),
    );
    rig.beginRouterPreset(MEDIUM_ELECTRICAL);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(5, 5) });

    clickPlace(rig, 5, 5);
    rig.refuse(1, 'FootprintCollision');
    rig.flushRaf();
    rig.flushRaf();

    expect(rig.sent.map((b) => [...b])).toEqual([placeFrame(machine_kind.ROUTER, 5, 5)]);
  });

  // Plan 76-10 (walk 76-09 CR-02-PAUSED). On a paused board a label is grown over (15,12)
  // and a Place is dropped there; the cell is FREE when the Place is emitted, so there is
  // no occupant to exclude. After Play the host folds the grow and refuses the Place, so
  // the next frame shows the grown label covering the cell and no machine. The watcher
  // used to take "a node now covers my cell" for "my Place echoed": it selected the label,
  // opened its panel with the caret in Text, and sent the queued Rotate (or the preset's
  // seeding) at it. A label 6 by 1 anchored at (10,12) is that host answer.
  const grownLabel = (): NodeView =>
    node({ id: 7, kind: machine_kind.LABEL, cell_x: 10, cell_y: 12, w: 6, h: 1 });

  it('a_refused_place_never_adopts_a_label_that_grew_over_its_cell', () => {
    rig = setupRig();
    rig.begin(machine_kind.SOURCE);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(15, 12) });
    rig.win.fire('keydown', { key: 'r', shiftKey: false, preventDefault: () => {} });
    expect(rig.overlay.ghostCalls.at(-1)?.dims?.rot, 'the ghost is turned once').toBe(1);

    clickPlace(rig, 15, 12);
    // The host's answer after Play: the grow folded, the Place refused, no Source.
    rig.refuse(1, 'FootprintCollision');
    rig.scene.nodes.set(7, grownLabel());
    rig.flushRaf();
    rig.flushRaf();

    expect(rig.sent.map((b) => [...b]), 'only the Place; no Rotate went out').toEqual([
      placeFrame(machine_kind.SOURCE, 15, 12),
    ]);
    expect(rig.onSelectCalls, 'the label was not selected').toEqual([]);
    expect(rig.onLabelPlacedCalls, 'the label panel was not asked for Text focus').toEqual([]);
    expect(rig.overlay.selections, 'no selection outline').toEqual([]);
  });

  it('a_refused_router_preset_place_never_seeds_a_label_that_grew_over_its_cell', () => {
    rig = setupRig();
    rig.beginRouterPreset(MEDIUM_ELECTRICAL);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(15, 12) });

    clickPlace(rig, 15, 12);
    rig.refuse(1, 'FootprintCollision');
    rig.scene.nodes.set(7, grownLabel());
    rig.flushRaf();
    rig.flushRaf();

    expect(rig.sent.map((b) => [...b]), 'only the Place; no Configure or AddPort at the label').toEqual([
      placeFrame(machine_kind.ROUTER, 15, 12),
    ]);
    expect(rig.onSelectCalls, 'the label was not selected').toEqual([]);
    expect(rig.onLabelPlacedCalls, 'the label panel was not asked for Text focus').toEqual([]);
    expect(rig.overlay.selections, 'no selection outline').toEqual([]);
  });

  // The two cases above are guarded by the anchor test and the kind test TOGETHER (the
  // grown label is neither anchored at the cell nor a Source), so neither test alone
  // reddens them (measured by mutation, plan 76-10). These two pin each test on its own,
  // on the same paused-board shape: several Places queued in one pass, some minted, one
  // refused.
  const rotateFrame = (id: number): number[] => [
    ...encodeGridCommand({ kind: 'Rotate', node: id, ccw: false }),
  ];

  it('a_refused_place_never_adopts_a_machine_minted_on_its_row_or_column', () => {
    // Ghost turned once, three Sources dropped while paused: (5,12) and (15,5) are free,
    // (15,12) is under the queued grow. After Play the host mints the first two (ids 1
    // and 2) and refuses the third. Each minted Source gets its own one Rotate; the
    // refused Place adopts neither (1 shares its row, 2 its column) nor the label.
    rig = setupRig();
    rig.begin(machine_kind.SOURCE);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(5, 12) });
    rig.win.fire('keydown', { key: 'r', shiftKey: false, preventDefault: () => {} });
    clickPlace(rig, 5, 12);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(15, 5) });
    clickPlace(rig, 15, 5);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(15, 12) });
    clickPlace(rig, 15, 12);
    rig.accept(1, [1]);
    rig.accept(2, [2]);
    rig.refuse(3, 'FootprintCollision');
    rig.scene.nodes.set(1, node({ id: 1, kind: machine_kind.SOURCE, cell_x: 5, cell_y: 12 }));
    rig.scene.nodes.set(2, node({ id: 2, kind: machine_kind.SOURCE, cell_x: 15, cell_y: 5 }));
    rig.scene.nodes.set(7, grownLabel());
    rig.flushRaf();
    rig.flushRaf();

    expect(rig.sent.map((b) => [...b]), 'three Places, then one Rotate for each minted Source').toEqual([
      placeFrame(machine_kind.SOURCE, 5, 12),
      placeFrame(machine_kind.SOURCE, 15, 5),
      placeFrame(machine_kind.SOURCE, 15, 12),
      rotateFrame(1),
      rotateFrame(2),
    ]);
    expect(rig.onSelectCalls, 'nothing was selected').toEqual([]);
    expect(rig.onLabelPlacedCalls, 'no Text focus was asked').toEqual([]);
  });

  it('a_refused_place_never_adopts_another_kind_minted_at_its_cell', () => {
    // While paused, a Merge dropped on (15,12), then the Source tool armed, turned once
    // and dropped on the same cell (still free on the client: nothing has folded). After
    // Play the host mints the Merge (id 3) and refuses the Source. The Merge is anchored
    // at the Source's cell, but it is not a Source: the Source's Rotate never goes out.
    rig = setupRig();
    rig.begin(machine_kind.MERGE);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(15, 12) });
    clickPlace(rig, 15, 12);
    rig.begin(machine_kind.SOURCE);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(15, 12) });
    rig.win.fire('keydown', { key: 'r', shiftKey: false, preventDefault: () => {} });
    clickPlace(rig, 15, 12);
    rig.accept(1, [3]);
    rig.refuse(2, 'FootprintCollision');
    rig.scene.nodes.set(
      3,
      node({ id: 3, kind: machine_kind.MERGE, cell_x: 15, cell_y: 12, w: 2, h: 2 }),
    );
    rig.flushRaf();
    rig.flushRaf();

    expect(rig.sent.map((b) => [...b]), 'the two Places and nothing at the Merge').toEqual([
      placeFrame(machine_kind.MERGE, 15, 12),
      placeFrame(machine_kind.SOURCE, 15, 12),
    ]);
  });

  // Refuter round after plan 76-10: two Places of the SAME kind on ONE free cell in one
  // paused pass. The host mints the first and refuses the second (FootprintCollision), so
  // exactly one node appears, anchored at that cell with that kind, and BOTH pending
  // entries match it by anchor, kind and occupant. Only the Place that minted it (the
  // first, the host drains in emit order) may take it as its echo: one minted node is
  // one echo. Without that, the refused Place sent its queued Rotates (or a preset's
  // seeding, or the label's focus request) at the first Place's machine.
  it('a_refused_same_cell_second_place_never_turns_the_first_places_machine', () => {
    // The first drop is unturned, the ghost is turned once, the second drop is refused.
    rig = setupRig();
    rig.begin(machine_kind.SOURCE);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(15, 12) });
    clickPlace(rig, 15, 12);
    rig.win.fire('keydown', { key: 'r', shiftKey: false, preventDefault: () => {} });
    clickPlace(rig, 15, 12);
    rig.accept(1, [3]);
    rig.refuse(2, 'FootprintCollision');
    rig.scene.nodes.set(3, node({ id: 3, kind: machine_kind.SOURCE, cell_x: 15, cell_y: 12 }));
    rig.flushRaf();
    rig.flushRaf();
    rig.flushRaf();

    expect(rig.sent.map((b) => [...b]), 'two Places and no Rotate at the unturned Source').toEqual([
      placeFrame(machine_kind.SOURCE, 15, 12),
      placeFrame(machine_kind.SOURCE, 15, 12),
    ]);
  });

  it('a_refused_same_cell_second_place_never_adds_a_second_turn', () => {
    // The ghost is turned once before both drops: the one minted Source gets ONE Rotate.
    rig = setupRig();
    rig.begin(machine_kind.SOURCE);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(15, 12) });
    rig.win.fire('keydown', { key: 'r', shiftKey: false, preventDefault: () => {} });
    clickPlace(rig, 15, 12);
    clickPlace(rig, 15, 12);
    rig.accept(1, [1]);
    rig.refuse(2, 'FootprintCollision');
    rig.scene.nodes.set(1, node({ id: 1, kind: machine_kind.SOURCE, cell_x: 15, cell_y: 12 }));
    rig.flushRaf();
    rig.flushRaf();
    rig.flushRaf();

    expect(rig.sent.map((b) => [...b]), 'two Places, ONE Rotate for the one minted Source').toEqual([
      placeFrame(machine_kind.SOURCE, 15, 12),
      placeFrame(machine_kind.SOURCE, 15, 12),
      rotateFrame(1),
    ]);
  });

  it('a_refused_same_cell_place_after_a_rearm_never_turns_the_first_places_machine', () => {
    // The palette path (refuter 2's live walk): drop a Source, Escape, arm the Source
    // tool again, turn the ghost once, drop on the same cell. Arming a tool abandons the
    // first Place's follow-ups, but its Place is still on the wire and still mints the
    // Source; the refused second Place must not take that Source for its own.
    rig = setupRig();
    rig.begin(machine_kind.SOURCE);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(15, 12) });
    clickPlace(rig, 15, 12);
    rig.win.fire('keydown', { key: 'Escape', preventDefault: () => {} });
    rig.begin(machine_kind.SOURCE);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(15, 12) });
    rig.win.fire('keydown', { key: 'r', shiftKey: false, preventDefault: () => {} });
    clickPlace(rig, 15, 12);
    rig.accept(1, [1]);
    rig.refuse(2, 'FootprintCollision');
    rig.scene.nodes.set(1, node({ id: 1, kind: machine_kind.SOURCE, cell_x: 15, cell_y: 12 }));
    rig.flushRaf();
    rig.flushRaf();
    rig.flushRaf();

    expect(rig.sent.map((b) => [...b]), 'two Places and no Rotate at the first Place\'s Source').toEqual([
      placeFrame(machine_kind.SOURCE, 15, 12),
      placeFrame(machine_kind.SOURCE, 15, 12),
    ]);
  });

  it('a_refused_same_cell_second_router_preset_place_never_seeds_twice', () => {
    // What ONE preset Place plus its echo sends, read off a reference rig.
    rig = setupRig();
    rig.beginRouterPreset(MEDIUM_ELECTRICAL);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(15, 12) });
    clickPlace(rig, 15, 12);
    rig.accept(1, [3]);
    rig.scene.nodes.set(3, node({ id: 3, kind: machine_kind.ROUTER, cell_x: 15, cell_y: 12, w: 2, h: 3 }));
    rig.flushRaf();
    rig.flushRaf();
    const once = rig.sent.map((b) => [...b]);
    expect(once.length, 'the reference rig seeded the preset').toBeGreaterThan(1);
    rig.destroy();

    rig = setupRig();
    rig.beginRouterPreset(MEDIUM_ELECTRICAL);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(15, 12) });
    clickPlace(rig, 15, 12);
    clickPlace(rig, 15, 12);
    rig.accept(1, [3]);
    rig.refuse(2, 'FootprintCollision');
    rig.scene.nodes.set(3, node({ id: 3, kind: machine_kind.ROUTER, cell_x: 15, cell_y: 12, w: 2, h: 3 }));
    rig.flushRaf();
    rig.flushRaf();
    rig.flushRaf();

    expect(rig.sent.map((b) => [...b]), 'two Places and ONE seeding of the one minted Router').toEqual([
      placeFrame(machine_kind.ROUTER, 15, 12),
      ...once,
    ]);
  });

  it('a_refused_same_cell_second_label_place_never_asks_for_focus_twice', () => {
    rig = setupRig();
    rig.begin(machine_kind.LABEL);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(15, 12) });
    clickPlace(rig, 15, 12);
    clickPlace(rig, 15, 12);
    rig.accept(1, [3]);
    rig.refuse(2, 'FootprintCollision');
    rig.scene.nodes.set(3, node({ id: 3, kind: machine_kind.LABEL, cell_x: 15, cell_y: 12 }));
    rig.flushRaf();
    rig.flushRaf();
    rig.flushRaf();

    expect(rig.onLabelPlacedCalls, 'the one minted label asks for Text focus once').toEqual([3]);
    expect(rig.onSelectCalls, 'and is selected once').toEqual([3]);
  });

  // An abandoned entry stays until its own verdict ends it (phase 88, D-06). These pin what
  // that must NOT change: an abandoned entry still sends nothing and takes no focus (D-08),
  // a keyframe is not an answer, and the shimmer still clears when the last LIVE Place lands.
  it('an_abandoned_label_place_never_takes_focus_when_it_echoes', () => {
    rig = setupRig();
    rig.begin(machine_kind.LABEL);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(15, 12) });
    clickPlace(rig, 15, 12);
    // Arming another tool before the echo gives up the label's follow-ups.
    rig.begin(machine_kind.SOURCE);
    // The label's accept and its packet both arrive after that, through `onVerdict`.
    rig.accept(1, [3]);
    rig.scene.nodes.set(3, node({ id: 3, kind: machine_kind.LABEL, cell_x: 15, cell_y: 12 }));
    rig.flushRaf();
    rig.flushRaf();

    expect(rig.onLabelPlacedCalls, 'no Text focus for an abandoned label').toEqual([]);
    expect(rig.onSelectCalls, 'nothing selected').toEqual([]);
    expect(rig.armedCalls.at(-1), 'the Source tool stays in hand').toEqual({
      kind: 'machine',
      machineKind: machine_kind.SOURCE,
    });
  });

  it('a_place_dropped_on_a_blocker_then_abandoned_never_takes_the_corrected_places_machine', () => {
    // The correction flow while paused: a Source dropped on a Source X that already sits
    // at (15,12) (the host will refuse it), the tool put down, X deleted, the tool armed
    // again, the ghost turned once, and a Source dropped on the same cell. After Play the
    // host refuses the first Place (X is still there when it drains), deletes X and mints
    // the second (id 9). The first Place's watch must not claim id 9: it is the turned
    // second Place's machine and gets that Place's one Rotate.
    rig = setupRig(node({ id: 4, kind: machine_kind.SOURCE, cell_x: 15, cell_y: 12 }));
    rig.begin(machine_kind.SOURCE);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(15, 12) });
    clickPlace(rig, 15, 12);
    rig.win.fire('keydown', { key: 'Escape', preventDefault: () => {} });
    rig.commit(4);
    rig.begin(machine_kind.SOURCE);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(15, 12) });
    rig.win.fire('keydown', { key: 'r', shiftKey: false, preventDefault: () => {} });
    clickPlace(rig, 15, 12);
    // The host refuses the first Place (X still stands when it drains), deletes X and mints
    // the second as 9.
    rig.refuse(1, 'FootprintCollision');
    rig.accept(2, []);
    rig.accept(3, [9]);
    rig.scene.nodes.delete(4);
    rig.scene.nodes.set(9, node({ id: 9, kind: machine_kind.SOURCE, cell_x: 15, cell_y: 12 }));
    rig.flushRaf();
    rig.flushRaf();
    rig.flushRaf();

    expect(rig.sent.map((b) => [...b]), 'the corrected Place\'s machine gets its one Rotate').toEqual([
      placeFrame(machine_kind.SOURCE, 15, 12),
      [...encodeGridCommand({ kind: 'Delete', node: 4 })],
      placeFrame(machine_kind.SOURCE, 15, 12),
      rotateFrame(9),
    ]);
  });

  // Phase 88 red-first probe (plan 88-01, WORK-04, D-06), turned on by plan 88-05: each Place
  // now ends on its own verdict.
  it(
    'a_queued_delete_then_two_drops_turns_nothing [red-first: WORK-04; plan 88-05 turns this on]',
    () => {
      // Source X (id 4) at (15,12). Before anything folds (a paused board, then Play) the user
      // deletes X, arms Source and drops on (15,12), presses Escape, arms Source again, turns
      // the ghost once and drops on (15,12) again. The host deletes X, mints the FIRST Place's
      // Source as handle 9 at generation 0, and refuses the second, turned Place: its cell is
      // taken by then. Nothing the user turned was placed, so no Rotate may go out.
      rig = setupRig(node({ id: 4, kind: machine_kind.SOURCE, cell_x: 15, cell_y: 12 }));
      rig.commit(4);
      const del = rig.sent.length;
      rig.begin(machine_kind.SOURCE);
      rig.win.fire('pointermove', { target: rig.canvas, ...at(15, 12) });
      clickPlace(rig, 15, 12);
      const first = rig.sent.length;
      rig.win.fire('keydown', { key: 'Escape', preventDefault: () => {} });
      rig.begin(machine_kind.SOURCE);
      rig.win.fire('pointermove', { target: rig.canvas, ...at(15, 12) });
      rig.win.fire('keydown', { key: 'r', shiftKey: false, preventDefault: () => {} });
      clickPlace(rig, 15, 12);
      const second = rig.sent.length;
      rig.verdict({ kind: 'gestureAccepted', seq: del, generation: 0, minted: [] });
      rig.verdict({ kind: 'gestureAccepted', seq: first, generation: 0, minted: [9] });
      rig.verdict({ kind: 'gestureRefused', seq: second, tag: 'FootprintCollision' });
      rig.scene.nodes.delete(4);
      rig.scene.nodes.set(9, node({ id: 9, kind: machine_kind.SOURCE, cell_x: 15, cell_y: 12 }));
      rig.flushRaf();
      rig.flushRaf();
      rig.flushRaf();

      const sent = rig.sent.map((b) => [...b]);
      console.log(`P88-W4 sent=${JSON.stringify(sent)} ids=${JSON.stringify({ del, first, second })}`);
      expect(sent, 'the Delete and the two Places, and no Rotate: the turned Place was refused').toEqual([
        [...encodeGridCommand({ kind: 'Delete', node: 4 })],
        placeFrame(machine_kind.SOURCE, 15, 12),
        placeFrame(machine_kind.SOURCE, 15, 12),
      ]);
    },
  );

  // THE ORDER OF AN ACCEPT AND ITS PACKET (plan 88-05, D-06, research Pitfall 3): neither
  // transport orders verdicts against render packets, so a turned Place's Rotate goes out only
  // when BOTH are in, whichever came first, and exactly once.
  const turnedDropAt = (r: Rig, cx: number, cy: number): number => {
    r.begin(machine_kind.SOURCE);
    r.win.fire('pointermove', { target: r.canvas, ...at(cx, cy) });
    r.win.fire('keydown', { key: 'r', shiftKey: false, preventDefault: () => {} });
    clickPlace(r, cx, cy);
    return r.sent.length;
  };

  it('a Place sent with no transport waits for nothing, and a verdict naming id 0 lands nothing (phase 88 review, IN-05)', () => {
    // The send seam returns 0 when there is no transport and nothing was sent. No pending
    // entry may be made for it: no waiting shimmer for a Place the host never received, and no
    // entry under id 0 for a verdict naming id 0 to pair with (16-router-presets sends raw
    // frames as id 0 so that their verdicts pair with nothing).
    rig = setupRigWith({ noTransport: true });
    const place = turnedDropAt(rig, 5, 5);
    expect(place, 'PRECONDITION: the Place was attempted').toBe(1);
    expect(rig.overlay.pendingCalls, 'no waiting shimmer for a Place that was not sent').toEqual([]);
    rig.scene.nodes.set(7, node({ id: 7, kind: machine_kind.SOURCE, cell_x: 5, cell_y: 5 }));
    rig.accept(0, [7]);
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent, 'a verdict naming id 0 sends no Rotate').toHaveLength(1);
    expect(rig.waiting().placements, 'and nothing waits').toBe(0);
  });

  it('an_accept_before_its_packet_waits_for_the_packet', () => {
    rig = setupRig();
    rig.scene.generation = 3;
    const place = turnedDropAt(rig, 5, 5);
    rig.accept(place, [7], 3);
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent, 'no Rotate while no packet holds handle 7').toHaveLength(1);
    rig.scene.nodes.set(7, node({ id: 7, kind: machine_kind.SOURCE, cell_x: 5, cell_y: 5 }));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent.map((b) => [...b]), 'one Rotate, at the handle the accept named').toEqual([
      placeFrame(machine_kind.SOURCE, 5, 5),
      rotateFrame(7),
    ]);
    expect(rig.sentOpts[1], "the Rotate names the accept's generation").toEqual({ generation: 3 });
  });

  it('a_packet_before_its_accept_waits_for_the_accept', () => {
    rig = setupRig();
    rig.scene.generation = 3;
    const place = turnedDropAt(rig, 5, 5);
    rig.scene.nodes.set(7, node({ id: 7, kind: machine_kind.SOURCE, cell_x: 5, cell_y: 5 }));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent, 'no Rotate on the packet alone: the client no longer guesses').toHaveLength(1);
    rig.accept(place, [7], 3);
    rig.flushRaf();
    expect(rig.sent.map((b) => [...b]), 'one Rotate, at the handle the accept named').toEqual([
      placeFrame(machine_kind.SOURCE, 5, 5),
      rotateFrame(7),
    ]);
    expect(rig.sentOpts[1], "the Rotate names the accept's generation").toEqual({ generation: 3 });
  });

  it('a_duplicate_verdict_is_ignored', () => {
    rig = setupRig();
    const place = turnedDropAt(rig, 5, 5);
    rig.accept(place, [7]);
    rig.accept(place, [7]);
    rig.scene.nodes.set(7, node({ id: 7, kind: machine_kind.SOURCE, cell_x: 5, cell_y: 5 }));
    rig.flushRaf();
    rig.accept(place, [7]);
    rig.flushRaf();
    expect(rig.sent.map((b) => [...b]), 'the Rotate goes out once').toEqual([
      placeFrame(machine_kind.SOURCE, 5, 5),
      rotateFrame(7),
    ]);
  });

  it('a_reminted_handle_goes_to_the_place_whose_accept_names_it (phase 88; was a_keyframe_ends_every_echo_claim)', () => {
    // Two Sources pending; the first is accepted as handle 1 and lands. A keyframe (an undo
    // to an empty board, generation 1) remints handles from 0, and a new turned Source at
    // another cell is accepted as handle 1 at generation 1: its Rotate goes to (1, 1). The
    // second Source, still unanswered across the keyframe, is refused and sends nothing.
    rig = setupRig();
    rig.begin(machine_kind.SOURCE);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(5, 5) });
    clickPlace(rig, 5, 5);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(9, 9) });
    clickPlace(rig, 9, 9);
    rig.accept(1, [1]);
    rig.scene.nodes.set(1, node({ id: 1, kind: machine_kind.SOURCE, cell_x: 5, cell_y: 5 }));
    rig.flushRaf();
    rig.clearSel();
    rig.scene.nodes.clear();
    rig.scene.generation = 1;
    rig.win.fire('pointermove', { target: rig.canvas, ...at(7, 7) });
    rig.win.fire('keydown', { key: 'r', shiftKey: false, preventDefault: () => {} });
    clickPlace(rig, 7, 7);
    rig.refuse(2, 'FootprintCollision');
    rig.accept(3, [1], 1);
    rig.scene.nodes.set(1, node({ id: 1, kind: machine_kind.SOURCE, cell_x: 7, cell_y: 7 }));
    rig.flushRaf();
    rig.flushRaf();

    expect(rig.sent.map((b) => [...b]), 'the post-keyframe Source gets its one Rotate').toEqual([
      placeFrame(machine_kind.SOURCE, 5, 5),
      placeFrame(machine_kind.SOURCE, 9, 9),
      placeFrame(machine_kind.SOURCE, 7, 7),
      rotateFrame(1),
    ]);
    expect(rig.sentOpts[3], 'addressed in the table of generation 1').toEqual({ generation: 1 });
  });

  it('the_pending_shimmer_clears_when_the_last_live_place_echoes_while_an_abandoned_one_watches', () => {
    rig = setupRig();
    rig.begin(machine_kind.SOURCE);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(5, 5) });
    clickPlace(rig, 5, 5);
    rig.win.fire('keydown', { key: 'Escape', preventDefault: () => {} });
    rig.begin(machine_kind.SOURCE);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(8, 8) });
    clickPlace(rig, 8, 8);
    const clearedBefore = rig.overlay.pendingCleared.count;
    // Only the live second Place is answered and echoes; the abandoned first is still unanswered.
    rig.accept(2, [2]);
    rig.scene.nodes.set(2, node({ id: 2, kind: machine_kind.SOURCE, cell_x: 8, cell_y: 8 }));
    rig.flushRaf();

    expect(rig.overlay.pendingCleared.count, 'the shimmer cleared on the live echo').toBeGreaterThan(
      clearedBefore,
    );
  });

  it('the pending shimmer clears on the host echo (IX-05 honest success)', () => {
    rig = setupRig();
    armAndHover(rig, 5, 5);
    clickPlace(rig, 5, 5);
    expect(rig.overlay.pendingCalls).toHaveLength(1);
    const clearedBefore = rig.overlay.pendingCleared.count;

    // The host accepts it as 42 and echoes the node into the placed cell → the shimmer
    // clears (the real machine appears from the machines layer, not from any local write).
    rig.accept(1, [42]);
    rig.scene.nodes.set(42, node({ id: 42, cell_x: 5, cell_y: 5 }));
    rig.flushRaf();
    expect(rig.overlay.pendingCleared.count).toBeGreaterThan(clearedBefore);
  });

  it('the pending shimmer clears silently on the TTL when no echo lands (IX-05)', () => {
    rig = setupRig();
    armAndHover(rig, 5, 5);
    clickPlace(rig, 5, 5);
    const clearedBefore = rig.overlay.pendingCleared.count;

    // No echo; the sim advances past ECHO_TTL_TICKS (120) → silent clear.
    rig.scene.tick = 121;
    rig.flushRaf();
    expect(rig.overlay.pendingCleared.count).toBeGreaterThan(clearedBefore);
  });

  it('Escape disarms: cursor cleared, pan restored, onArmedChange(null), later click emits nothing (IX-03)', () => {
    rig = setupRig();
    armAndHover(rig, 5, 5);

    rig.win.fire('keydown', { key: 'Escape', preventDefault: () => {} });

    expect(rig.cursor()).toBe('');
    expect(rig.panState.enabled).toBe(true);
    expect(rig.armedCalls.at(-1)).toBeNull();
    // Disarmed: a later click emits nothing.
    clickPlace(rig, 5, 5);
    expect(rig.sent).toHaveLength(0);
  });

  it('a right-click on the canvas disarms: cursor cleared, pan restored, onArmedChange(null) (IX-03/08)', () => {
    rig = setupRig();
    armAndHover(rig, 5, 5);

    rig.canvas.fire('pointerdown', { button: 2, target: rig.canvas, ...at(5, 5) });

    expect(rig.cursor()).toBe('');
    expect(rig.panState.enabled).toBe(true);
    expect(rig.armedCalls.at(-1)).toBeNull();
    expect(rig.sent).toHaveLength(0);
  });

  it('re-clicking the armed tool toggles it off (re-click disarm, IX-03)', () => {
    rig = setupRig();
    rig.begin(machine_kind.SOURCE);
    expect(rig.armedCalls).toEqual([{ kind: 'machine', machineKind: machine_kind.SOURCE }]);

    // Re-arming the SAME kind disarms (Factorio re-click toggle).
    rig.begin(machine_kind.SOURCE);
    expect(rig.armedCalls.at(-1)).toBeNull();
    expect(rig.cursor()).toBe('');
    expect(rig.panState.enabled).toBe(true);
    // Disarmed: a later click emits nothing.
    clickPlace(rig, 5, 5);
    expect(rig.sent).toHaveLength(0);
  });

  it('arming a DIFFERENT machine switches (not toggles) and keeps exactly one tool armed', () => {
    rig = setupRig();
    rig.begin(machine_kind.SOURCE);
    rig.begin(machine_kind.SINK);
    // Switched to SINK (still armed) — a legal click places a SINK.
    expect(rig.armedCalls.at(-1)).toEqual({ kind: 'machine', machineKind: machine_kind.SINK });
    expect(rig.cursor()).toBe('crosshair');
    rig.win.fire('pointermove', { target: rig.canvas, ...at(5, 5) });
    clickPlace(rig, 5, 5);
    expect(rig.sent).toHaveLength(1);
    expect(rig.sent[0][1]).toBe(machine_kind.SINK); // kind_byte
  });
});

// WR-C: switching tools while a placement is still pending must clear the
// neutral IX-05 shimmer (the WR-B fix). The single cleaner used to be the echo
// watcher / clearSelection, so a tool-supersede stranded the shimmer pulsing
// over the committed machine. Both supersede paths — arming a DIFFERENT machine
// (beginPlacement) and arming the Belt tool (armBeltDraw) — must bump
// overlay.pendingCleared. This is the case whose absence let WR-B through.
describe('Tool-supersede clears the pending shimmer (WR-C / WR-B / IX-05)', () => {
  /** Arm `kind`, hover (cx,cy), then click-place there so a shimmer is pending. */
  const armPlaceAt = (r: Rig, kind: number, cx: number, cy: number): void => {
    r.begin(kind);
    r.win.fire('pointermove', { target: r.canvas, ...at(cx, cy) });
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...at(cx, cy) });
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...at(cx, cy) });
  };

  it('arming a DIFFERENT machine while a placement is pending clears the shimmer', () => {
    rig = setupRig();
    armPlaceAt(rig, machine_kind.SOURCE, 5, 5);
    // The neutral pending shimmer is shown at the placed cell (not yet echoed).
    expect(rig.overlay.pendingCalls).toHaveLength(1);
    expect(rig.overlay.pendingCalls[0].cell).toEqual({ cx: 5, cy: 5 });
    const clearedBefore = rig.overlay.pendingCleared.count;

    // Switch to a different machine WITHOUT the echo ever landing.
    rig.begin(machine_kind.SINK);
    expect(rig.overlay.pendingCleared.count).toBeGreaterThan(clearedBefore);
  });

  it('arming the Belt tool while a placement is pending clears the shimmer', () => {
    rig = setupRig();
    armPlaceAt(rig, machine_kind.SOURCE, 5, 5);
    expect(rig.overlay.pendingCalls).toHaveLength(1);
    const clearedBefore = rig.overlay.pendingCleared.count;

    // Switch to the Belt tool WITHOUT the echo ever landing.
    rig.armBelt();
    expect(rig.overlay.pendingCleared.count).toBeGreaterThan(clearedBefore);
  });

  // Phase 88 red-first probe (plan 88-01, FAIL-07, WINDOWS 87, D-10), turned on by plan 88-05:
  // a pending Place now ends on its own verdict.
  it(
    'a_refused_place_clears_its_own_shimmer_on_its_verdict [red-first: FAIL-07; plan 88-05 turns this on]',
    () => {
      // A Source already sits on (5,5). The user drops another Source there: the client
      // flashes red (the ghost knows the cell is taken), and the Place is still sent, because
      // the ghost is advisory and the host is the judge. The waiting shimmer goes up beside
      // the flash. The host refuses the Place at the same tick (the board is paused, the tick
      // does not move): the shimmer must clear on that verdict, leaving the red flash as the
      // only mark on the cell.
      rig = setupRig(node({ id: 4, kind: machine_kind.SOURCE, cell_x: 5, cell_y: 5 }));
      rig.setPlaying(false);
      armPlaceAt(rig, machine_kind.SOURCE, 5, 5);
      const place = rig.sent.length;
      const rejectFlash = rig.overlay.rejectFlashCalls.length;
      const pendingShown = rig.overlay.pendingCalls.length;
      const clearedBefore = rig.overlay.pendingCleared.count;
      rig.verdict({ kind: 'gestureRefused', seq: place, tag: 'FootprintCollision' });
      for (let i = 0; i < 5; i++) {
        rig.flushRaf();
      }
      const pendingCleared = rig.overlay.pendingCleared.count - clearedBefore;
      console.log(
        `P88-F7 sent=${place} rejectFlash=${rejectFlash} pendingShown=${pendingShown} pendingCleared=${pendingCleared} (paused tick ${rig.scene.tick}, after 5 frames)`,
      );
      expect(place, 'PRECONDITION: the Place was sent').toBe(1);
      expect(rejectFlash, 'PRECONDITION: the red flash fired on the taken cell').toBe(1);
      expect(pendingShown, 'PRECONDITION: the waiting shimmer went up').toBe(1);
      expect(pendingCleared, 'the refusal cleared its own shimmer').toBeGreaterThan(0);
      expect(rig.overlay.rejectFlashCalls, 'and the red flash is still the only flash').toHaveLength(1);
    },
  );

  // THE ONE SHIMMER SLOT (plan 88-05, D-10, research Pitfall 9): the overlay paints one waiting
  // shimmer, the newest live Place's. A refusal clears it only when it shows the refused
  // Place, and then hands it to the newest Place still waiting.
  it('a_refusal_clears_only_its_own_shimmer', () => {
    rig = setupRig();
    rig.setPlaying(false);
    armPlaceAt(rig, machine_kind.SOURCE, 5, 5);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(9, 9) });
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(9, 9) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(9, 9) });
    expect(rig.overlay.pendingCalls.map((c) => c.cell), 'PRECONDITION: both shimmers went up in turn').toEqual([
      { cx: 5, cy: 5 },
      { cx: 9, cy: 9 },
    ]);
    const cleared = rig.overlay.pendingCleared.count;
    // The OLDER Place is refused: the slot shows the newer one, and keeps it.
    rig.refuse(1, 'FootprintCollision');
    rig.flushRaf();
    expect(rig.overlay.pendingCleared.count, "the older refusal did not wipe the newer Place's shimmer").toBe(cleared);
    expect(rig.overlay.pendingCalls.at(-1)?.cell, 'the slot still shows (9,9)').toEqual({ cx: 9, cy: 9 });

    // The converse: with three waiting, the NEWEST is refused; the slot clears and is handed
    // to the newest Place still waiting, not left empty.
    rig.win.fire('pointermove', { target: rig.canvas, ...at(13, 13) });
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(13, 13) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(13, 13) });
    const shown = rig.overlay.pendingCalls.length;
    rig.refuse(3, 'FootprintCollision');
    expect(rig.overlay.pendingCleared.count, 'its own shimmer cleared').toBe(cleared + 1);
    expect(rig.overlay.pendingCalls.length, 'and the slot repainted once').toBe(shown + 1);
    expect(rig.overlay.pendingCalls.at(-1)?.cell, "with (9,9)'s shimmer").toEqual({ cx: 9, cy: 9 });
    expect(rig.sent, 'three Places and nothing else').toHaveLength(3);
  });

  // D-07 (plan 88-05): the one timer left for a Place, for a verdict that was lost, counts
  // only ticks run while playing and restarts at Resume, as `resumePortEdit` does.
  it('a_lost_place_verdict_ends_on_playing_ticks_only', () => {
    rig = setupRig();
    rig.setPlaying(false);
    rig.begin(machine_kind.SOURCE);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(5, 5) });
    rig.win.fire('keydown', { key: 'r', shiftKey: false, preventDefault: () => {} });
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(5, 5) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(5, 5) });
    const place = rig.sent.length;
    const cleared = rig.overlay.pendingCleared.count;
    // A paused board drains 500 ticks with input held: none of them counts.
    rig.scene.tick = 500;
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.overlay.pendingCleared.count, 'paused: the drained ticks never end the Place').toBe(cleared);
    // Resume at 500: the count restarts there; 120 playing ticks are still within it.
    rig.setPlaying(true);
    rig.resume(500);
    rig.scene.tick = 620;
    rig.flushRaf();
    expect(rig.overlay.pendingCleared.count, 'playing, 120 ticks past Resume: still waiting').toBe(cleared);
    // The 121st playing tick ends it, with nothing sent.
    rig.scene.tick = 621;
    rig.flushRaf();
    expect(rig.overlay.pendingCleared.count, 'the lost verdict ends it and its shimmer').toBe(cleared + 1);
    // Ended: an accept arriving after that finds no entry, and no Rotate goes out.
    rig.accept(place, [7]);
    rig.scene.nodes.set(7, node({ id: 7, kind: machine_kind.SOURCE, cell_x: 5, cell_y: 5 }));
    rig.flushRaf();
    expect(rig.sent, 'only the Place').toHaveLength(1);
  });
});

// IX-03/08 belt parity: the Belt tool reports its armed state via onArmedChange
// and gets the same crosshair + re-click-toggle treatment as machines.
describe('Belt tool armed reporting + toggle (IX-03)', () => {
  it('arming the Belt tool sets crosshair and reports {kind:belt}', () => {
    rig = setupRig();
    rig.armBelt();
    expect(rig.cursor()).toBe('crosshair');
    expect(rig.armedCalls).toEqual([{ kind: 'belt' }]);
  });

  it('re-clicking the Belt tool toggles it off (onArmedChange(null), pan + cursor restored)', () => {
    rig = setupRig();
    rig.armBelt();
    rig.armBelt();
    expect(rig.armedCalls.at(-1)).toBeNull();
    expect(rig.panState.enabled).toBe(true);
    expect(rig.cursor()).toBe('');
  });

  it('Esc disarm reports onArmedChange(null)', () => {
    rig = setupRig();
    rig.armBelt();
    rig.win.fire('keydown', { key: 'Escape', preventDefault: () => {} });
    expect(rig.armedCalls.at(-1)).toBeNull();
  });
});

// IX-09: the global canvas shortcuts (Space / . / r / Delete) must NOT fire while
// a chrome BUTTON or SELECT owns focus — keyboard-arming a palette button (30-05)
// makes a focused BUTTON the common case, so the leak must close. Copies the
// App.tsx onHomeKey guard (BUTTON/SELECT in addition to INPUT/TEXTAREA/
// contentEditable) into gestures.ts onKey. The node vitest env has no DOM, so we
// stub globalThis.document.activeElement and tear it down after each case.
describe('onKey chrome-focus guard (IX-09)', () => {
  const setActive = (tagName: string): void => {
    (globalThis as unknown as { document: { activeElement: unknown } }).document = {
      activeElement: { tagName, isContentEditable: false },
    };
  };
  const selectNode = (r: Rig, cx: number, cy: number): void => {
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...at(cx, cy) });
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...at(cx, cy) });
  };
  afterEach(() => {
    delete (globalThis as unknown as { document?: unknown }).document;
  });

  it('a focused BUTTON suppresses r (no Rotate) and Delete (no emit/guard) on a selected node', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    selectNode(rig, 2, 2);
    expect(rig.selectedId()).toBe(7);

    setActive('BUTTON');
    rig.win.fire('keydown', { key: 'r', preventDefault: () => {} });
    rig.win.fire('keydown', { key: 'Delete', preventDefault: () => {} });

    expect(rig.sent).toHaveLength(0); // no Rotate leaked to the canvas
    expect(rig.deleteWithItems).toHaveLength(0); // no delete leaked either
  });

  it('a focused SELECT suppresses the canvas r shortcut too', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    selectNode(rig, 2, 2);

    setActive('SELECT');
    rig.win.fire('keydown', { key: 'r', preventDefault: () => {} });

    expect(rig.sent).toHaveLength(0);
  });

  // N3 (plan 74.1-20): undo and redo pass a focused BUTTON or SELECT, exactly as the
  // file accelerators do, and still stand down for a text field or a modal. On the
  // re-walk the user needed two Ctrl+Z presses to undo a join; with a button holding focus
  // the guard below dropped the first without a word (measured live, leg 3 of
  // `74.1-release-and-undo.live.spec.ts`).
  const undoKeys: Array<{ name: string; ev: Record<string, unknown>; want: { undo: number; redo: number } }> = [
    { name: 'Ctrl+Z', ev: { key: 'z', ctrlKey: true }, want: { undo: 1, redo: 0 } },
    { name: 'Cmd+Z', ev: { key: 'z', metaKey: true }, want: { undo: 1, redo: 0 } },
    { name: 'Ctrl+Shift+Z', ev: { key: 'Z', ctrlKey: true, shiftKey: true }, want: { undo: 0, redo: 1 } },
    { name: 'Cmd+Shift+Z', ev: { key: 'Z', metaKey: true, shiftKey: true }, want: { undo: 0, redo: 1 } },
    { name: 'Ctrl+Y', ev: { key: 'y', ctrlKey: true }, want: { undo: 0, redo: 1 } },
    { name: 'Cmd+Y', ev: { key: 'y', metaKey: true }, want: { undo: 0, redo: 1 } },
  ];
  const fireKey = (r: Rig, ev: Record<string, unknown>): { prevented: boolean } => {
    const out = { prevented: false };
    r.win.fire('keydown', {
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      ...ev,
      preventDefault: () => {
        out.prevented = true;
      },
    });
    return out;
  };
  const setActiveEl = (el: { tagName: string; isContentEditable: boolean }): void => {
    (globalThis as unknown as { document: { activeElement: unknown } }).document = { activeElement: el };
  };

  for (const tag of ['BUTTON', 'SELECT']) {
    for (const k of undoKeys) {
      it(`N3: a focused ${tag} lets ${k.name} through, exactly once, with preventDefault`, () => {
        rig = setupRig();
        setActiveEl({ tagName: tag, isContentEditable: false });
        const { prevented } = fireKey(rig, k.ev);
        expect(rig.counts).toEqual(k.want);
        expect(prevented, 'the browser binding is stopped').toBe(true);
        expect(rig.sent, 'dispatch is via the dep, never a direct emit').toHaveLength(0);
      });
    }
  }

  for (const [label, el] of [
    ['INPUT', { tagName: 'INPUT', isContentEditable: false }],
    ['TEXTAREA', { tagName: 'TEXTAREA', isContentEditable: false }],
    ['a contentEditable DIV', { tagName: 'DIV', isContentEditable: true }],
  ] as const) {
    it(`N3: ${label} focused: no undo or redo shortcut fires (the field's own undo is the user's)`, () => {
      rig = setupRig();
      setActiveEl(el);
      for (const k of undoKeys) {
        fireKey(rig, k.ev);
      }
      expect(rig.counts).toEqual({ undo: 0, redo: 0 });
    });
  }

  it('N3: a modal open stands every undo and redo shortcut down', () => {
    rig = setupRig();
    rig.modal.open = true;
    for (const k of undoKeys) {
      fireKey(rig, k.ev);
    }
    expect(rig.counts).toEqual({ undo: 0, redo: 0 });
    // NON-VACUITY: the same press fires once the modal closes.
    rig.modal.open = false;
    fireKey(rig, undoKeys[0].ev);
    expect(rig.counts).toEqual({ undo: 1, redo: 0 });
  });

  it('N3: a modal open stands them down with a BUTTON focused too (the modal guard comes first)', () => {
    rig = setupRig();
    setActiveEl({ tagName: 'BUTTON', isContentEditable: false });
    rig.modal.open = true;
    for (const k of undoKeys) {
      fireKey(rig, k.ev);
    }
    expect(rig.counts).toEqual({ undo: 0, redo: 0 });
  });

  it('N3: a focused BUTTON still suppresses every NON-accelerator shortcut (r, Delete, Escape)', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    selectNode(rig, 2, 2);
    expect(rig.selectedId(), 'NON-VACUITY: a node is selected').toBe(7);
    setActiveEl({ tagName: 'BUTTON', isContentEditable: false });
    fireKey(rig, { key: 'r' });
    fireKey(rig, { key: 'Delete' });
    fireKey(rig, { key: 'Escape' });
    expect(rig.sent).toHaveLength(0);
    expect(rig.deleteWithItems).toHaveLength(0);
    expect(rig.selectedId(), 'Escape did not clear the selection through the button').toBe(7);
  });

  it('control: with NO chrome element focused, r on the selected node emits exactly one Rotate', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    selectNode(rig, 2, 2);
    // document is absent (torn down after each case) → the guard is a no-op.
    rig.win.fire('keydown', { key: 'r', preventDefault: () => {} });
    expect(rig.sent).toHaveLength(1); // Rotate fired; the guard did NOT block it
  });

  // ---------------------------------------------------------------------------
  // Phase 89 red-first probes (plan 89-01, D-01, D-16). Each was gated and seen red at
  // PHASE89_START, and the plan that fixed it turned it on: that plan removed the gate and the
  // red-first title suffix and changed nothing else, so the test that is green is the test that
  // was seen red. Since plan 89-09 none is gated. Each prints its
  // measured facts on `P89-` lines before it asserts. Every drag below moves in sub-cell
  // samples, never one clean cell per event.
  // ---------------------------------------------------------------------------

  it(
    'escape_with_a_focused_palette_button_disarms_an_armed_tool',
    () => {
      // W252 (D-11): a tool armed from the keyboard leaves the palette button focused. Escape must
      // still put the tool away, as the Ctrl accelerators pass a focused button.
      rig = setupRig();
      rig.armBelt();
      setActiveEl({ tagName: 'BUTTON', isContentEditable: false });
      fireKey(rig, { key: 'Escape' });
      console.log(`P89-W252 armed_calls=${JSON.stringify(rig.armedCalls)}`);
      expect(rig.armedCalls.at(-1), 'Escape past a focused BUTTON disarms the armed tool').toBeNull();
    },
  );

  it('escape_in_a_text_field_does_nothing_to_the_tool', () => {
    // The focus exemption is for a BUTTON or SELECT only (D-11): Escape typed in a text field is
    // the field's, so the path and the tool both stay. NON-VACUITY: with a BUTTON focused the same
    // Escape takes the path (and only the path), so the field cases are the guard's doing.
    rig = setupRig();
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(2, 2) });
    rig.win.fire('pointermove', { target: rig.canvas, clientX: 3.5, clientY: 2.5 });
    rig.win.fire('pointermove', { target: rig.canvas, clientX: 4.5, clientY: 2.5 });
    expect(rig.overlay.beltPreview.on, 'NON-VACUITY: the path is previewed').toBe(true);
    for (const el of [
      { tagName: 'INPUT', isContentEditable: false },
      { tagName: 'TEXTAREA', isContentEditable: false },
      { tagName: 'DIV', isContentEditable: true },
    ]) {
      setActiveEl(el);
      fireKey(rig, { key: 'Escape' });
      expect(rig.overlay.beltPreview.on, `${el.tagName} focused: the path stays`).toBe(true);
      expect(rig.armedCalls.at(-1), `${el.tagName} focused: the tool stays`).toEqual({ kind: 'belt' });
    }
    setActiveEl({ tagName: 'BUTTON', isContentEditable: false });
    fireKey(rig, { key: 'Escape' });
    expect(rig.overlay.beltPreview.on, 'a BUTTON focused: the first Escape takes the path').toBe(false);
    expect(rig.armedCalls.at(-1), 'and keeps the tool').toEqual({ kind: 'belt' });
  });
});

// IX-07: Escape clears an active node/belt selection when nothing is armed. The
// disarm-first ordering established in 30-03 still wins: an armed tool disarms
// first and a selection is NOT also cleared in the same press.
describe('Escape clears selection (IX-07)', () => {
  const selectNode = (r: Rig, cx: number, cy: number): void => {
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...at(cx, cy) });
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...at(cx, cy) });
  };

  it('Escape with a node selection and nothing armed clears it (selection null + teardown)', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    selectNode(rig, 2, 2);
    expect(rig.selectedId()).toBe(7);
    const clearedBefore = rig.overlay.beltHandlesCleared.count;

    rig.win.fire('keydown', { key: 'Escape', preventDefault: () => {} });

    expect(rig.selectedId()).toBeNull();
    expect(rig.overlay.beltHandlesCleared.count).toBeGreaterThan(clearedBefore);
  });

  it('Escape while a tool is armed disarms FIRST and does NOT also clear the selection', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    selectNode(rig, 2, 2);
    rig.begin(machine_kind.SOURCE); // arm on top of the selection
    expect(rig.selectedId()).toBe(7);

    rig.win.fire('keydown', { key: 'Escape', preventDefault: () => {} });

    // The tool disarmed…
    expect(rig.armedCalls.at(-1)).toBeNull();
    // …but the selection survives THIS press (disarm-first ordering, 30-03).
    expect(rig.selectedId()).toBe(7);

    // A SECOND Escape (nothing armed now) clears the selection.
    rig.win.fire('keydown', { key: 'Escape', preventDefault: () => {} });
    expect(rig.selectedId()).toBeNull();
  });

  // Phase-34 regression (IX-07 vs ONB-01): Escape with an active selection MUST
  // clear the selection, NOT run the lowest-priority welcome-card fallback. The
  // old capture-phase WelcomeCard handler swallowed Escape here and dismissed the
  // card instead; this pins the fallback strictly BELOW clear-selection.
  it('Escape with a selection clears it and does NOT fire the welcome-card fallback', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    selectNode(rig, 2, 2);
    expect(rig.selectedId()).toBe(7);

    rig.win.fire('keydown', { key: 'Escape', preventDefault: () => {} });

    // The selection cleared…
    expect(rig.selectedId()).toBeNull();
    // …and the card-dismiss fallback did NOT run (clear-selection wins IX-07).
    expect(rig.escapeFallback.count).toBe(0);
  });

  // ONB-01: only when Escape is OTHERWISE A NO-OP (nothing armed, nothing
  // selected) does it fall through to the lowest-priority welcome-card dismiss.
  it('Escape with nothing armed and nothing selected fires the fallback exactly once', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    expect(rig.selectedId()).toBeNull();

    rig.win.fire('keydown', { key: 'Escape', preventDefault: () => {} });

    expect(rig.escapeFallback.count).toBe(1);
    expect(rig.sent).toHaveLength(0); // a pure fallback, no command emitted
  });

  it('Escape while a tool is armed disarms FIRST and does NOT fire the fallback', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    rig.begin(machine_kind.SOURCE); // arm, nothing selected

    rig.win.fire('keydown', { key: 'Escape', preventDefault: () => {} });

    // The tool disarmed and the card fallback did NOT run (disarm-first wins).
    expect(rig.armedCalls.at(-1)).toBeNull();
    expect(rig.escapeFallback.count).toBe(0);
  });
});

// IX-04 (T-30-01): requestDelete(handle) is the SHARED delete-decision path the
// coming DOM delete button (30-06) and the keyboard Delete both route through. It
// runs the IDENTICAL in-flight-items guard: defer to onDeleteWithItems when items
// are in flight, otherwise exactly one commitDelete. No second decision path.
describe('requestDelete shared guard routing (IX-04 / T-30-01)', () => {
  const beltWithItems = (id: number, n: number, dockNode: number): BeltView => ({
    id,
    latency: 1,
    fill: 0,
    items: Array.from({ length: n }, () => ({ arrival_tick: 0, tag: 0 })),
    tiles: [],
    docks: [{ end: 'Head', node: dockNode, port: 0 }],
    // SLOT-03: the belt's own advance interval, appended LAST on the wire after
    // `docks`. 1 is the pre-change IDENTITY (the sim advances on every tick), so every
    // expectation in this file means what it meant before the field existed.
    ticks_per_slot: 1,
  });

  it('requestDelete on an empty machine emits exactly one Delete (disc 1), no guard', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));

    rig.requestDelete(7);

    expect(rig.deleteWithItems).toHaveLength(0);
    expect(rig.sent).toHaveLength(1);
    expect(rig.sent[0][0]).toBe(1); // Delete discriminant
    expect(rig.sent[0][rig.sent[0].length - 1]).toBe(7); // node = 7
  });

  it('requestDelete on an item-carrying machine defers to the guard and emits NOTHING', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    rig.scene.belts.set(3, beltWithItems(3, 2, 7));

    rig.requestDelete(7);

    expect(rig.sent).toHaveLength(0); // intercepted: no unguarded delete
    expect(rig.deleteWithItems).toEqual([
      { handle: 7, count: 2, kind: 'machine', beltIds: [3] },
    ]);
  });

  it('matches the keyboard Delete branch for the in-flight case (one shared decision)', () => {
    // Keyboard path: select the machine, press Delete → deferral shape.
    const kbdRig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    kbdRig.scene.belts.set(3, beltWithItems(3, 2, 7));
    kbdRig.canvas.fire('pointerdown', { button: 0, target: kbdRig.canvas, ...at(2, 2) });
    kbdRig.win.fire('pointerup', { button: 0, target: kbdRig.canvas, ...at(2, 2) });
    kbdRig.win.fire('keydown', { key: 'Delete', preventDefault: () => {} });
    const kbd = kbdRig.deleteWithItems.slice();
    kbdRig.destroy();

    // requestDelete path: identical deferral shape, still no unguarded emit.
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    rig.scene.belts.set(3, beltWithItems(3, 2, 7));
    rig.requestDelete(7);

    expect(rig.deleteWithItems).toEqual(kbd);
    expect(rig.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// WIRE-05: the wire tool's DISCOVERABILITY surface (plan 66-06)
// ---------------------------------------------------------------------------
//
// WINDOWS row 113, observed on the real binary 2026-08-25: "DOCKING IS UNDISCOVERABLE
// ... the user tried the intuitive inverse, dragging the Router's Out nub onto the belt's
// first tile, repeatedly. That gesture is silently inert: no preview, no reject flash,
// no message."
//
// 66-01 shipped a wire gesture that WORKS and cannot be FOUND: it ran at the same
// nubHitRadiusWorld target row 113 records a user failing to hit, and it painted
// nothing until the pointer was already inside that radius. These cases pin the three
// things that close it: a wider grab target (E7), a board-wide resting affordance
// painted BEFORE any press (E8), and the in-drag colour flip from red to blue on
// entering an accepting nub (E9).
describe('wire tool discoverability (WIRE-05)', () => {
  const ELEC = MEDIUM_ELECTRICAL;
  const MECH = MEDIUM_MECHANICAL;

  /** A 1x1 source node carrying one electrical Out at its own cell, facing E. */
  const sourceNode = (id: number, cx: number, cy: number): NodeView =>
    node({
      id,
      kind: machine_kind.ROUTER,
      cell_x: cx,
      cell_y: cy,
      ports: [{ index: 0, cell_x: cx, cell_y: cy, side: 1, role: 1, medium: ELEC }],
    });

  /** A 1x1 sink node carrying one electrical In at its own cell, facing W. */
  const sinkNode = (id: number, cx: number, cy: number): NodeView =>
    node({
      id,
      kind: machine_kind.FACTORY,
      cell_x: cx,
      cell_y: cy,
      ports: [{ index: 0, cell_x: cx, cell_y: cy, side: 3, role: 0, medium: ELEC }],
    });

  /** The world anchor of a node's single port. */
  const anchorOf = (n: NodeView): Pt => nubAnchor(n.ports[0].cell_x, n.ports[0].cell_y, n.ports[0].side);

  const press = (r: Rig, pt: Pt): void => {
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, clientX: pt.x, clientY: pt.y });
  };
  const move = (r: Rig, pt: Pt): void => {
    r.win.fire('pointermove', { target: r.canvas, clientX: pt.x, clientY: pt.y });
  };
  const up = (r: Rig, pt: Pt): void => {
    r.win.fire('pointerup', { button: 0, target: r.canvas, clientX: pt.x, clientY: pt.y });
  };
  /** The most recent showWireTargets payload. */
  const lastTargets = (r: Rig): Array<{ x: number; y: number; filled: boolean }> =>
    r.overlay.wireTargetCalls[r.overlay.wireTargetCalls.length - 1];

  // -------------------------------------------------------------------------
  // E8: the RESTING affordance. This is the actual discovery mechanism.
  // -------------------------------------------------------------------------

  it('E8: arming the Wire tool rings EVERY electrical nub on the board, before any press', () => {
    // Three electrical nubs across two nodes plus one MECHANICAL port that must NOT
    // ring: a wire can never land on it, so ringing it would promise a connection the
    // host refuses. The ring set is the board saying where a wire can start.
    const src = sourceNode(1, 2, 2);
    const sink = node({
      id: 2,
      kind: machine_kind.FACTORY,
      cell_x: 6,
      cell_y: 5,
      ports: [
        { index: 0, cell_x: 6, cell_y: 5, side: 3, role: 0, medium: ELEC },
        { index: 1, cell_x: 6, cell_y: 5, side: 0, role: 0, medium: MECH },
        { index: 2, cell_x: 6, cell_y: 5, side: 2, role: 1, medium: ELEC },
      ],
    });
    rig = setupRigWith({ cellsFromWorld: true }, src, sink);

    expect(rig.overlay.wireTargetCalls).toHaveLength(0); // nothing before the arm
    rig.armWire();

    expect(rig.overlay.wireTargetCalls).toHaveLength(1);
    expect(lastTargets(rig)).toEqual([
      { ...nubAnchor(2, 2, 1), filled: false },
      { ...nubAnchor(6, 5, 3), filled: false },
      { ...nubAnchor(6, 5, 2), filled: false },
    ]);
    // NONE filled: a ring is an affordance, a fill marks a nub already grabbed.
    expect(lastTargets(rig).some((p) => p.filled)).toBe(false);
  });

  it('E8: disarming clears the rings', () => {
    rig = setupRigWith({ cellsFromWorld: true }, sourceNode(1, 2, 2));
    rig.armWire();
    expect(rig.overlay.wireTargetsCleared.count).toBe(0);
    rig.armWire(); // re-click toggle = disarm
    expect(rig.overlay.wireTargetsCleared.count).toBeGreaterThan(0);
  });

  it('E8: a board with NO electrical ports arms cleanly and rings nothing', () => {
    // UI-SPEC 6.2 empty case. The tool arms, the cursor changes, and no ring appears:
    // "nothing here is wireable" is legible because the board stays dark.
    rig = setupRigWith(
      { cellsFromWorld: true },
      node({
        id: 1,
        cell_x: 2,
        cell_y: 2,
        ports: [{ index: 0, cell_x: 2, cell_y: 2, side: 1, role: 1, medium: MECH }],
      }),
    );
    expect(() => rig!.armWire()).not.toThrow();
    expect(rig.cursor()).toBe('crosshair');
    expect(lastTargets(rig)).toEqual([]);
  });

  it('E8: an Out that ALREADY carries a wire gets no ring, and stays pressable anyway', () => {
    // The affordance/gate distinction D-07/D-08 turns on. The ring is dropped because
    // that Out can only ever be refused PortOccupied (host step 6). The nub is NOT
    // gated: the press still acquires it, the release still emits, and the host still
    // answers in words. The client's read is a STALE READ BY CONSTRUCTION anyway.
    const src = sourceNode(1, 2, 2);
    const sink = sinkNode(2, 6, 5);
    rig = setupRigWith({ cellsFromWorld: true }, src, sink);
    rig.scene.wires.set(9, {
      id: 9,
      from: { node: 1, port: 0 },
      to: { node: 2, port: 0 },
      path: [],
      pulses: [],
    });

    rig.armWire();
    // Only the In rings: the occupied Out is dark.
    expect(lastTargets(rig)).toEqual([{ ...nubAnchor(6, 5, 3), filled: false }]);

    // ... and it is still pressable, still drags, still emits.
    press(rig, anchorOf(src));
    expect(lastTargets(rig)).toContainEqual({ ...anchorOf(src), filled: true });
    up(rig, anchorOf(sink));
    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({
        kind: 'DrawWire',
        from_node: 1,
        from_port: 0,
        to_node: 2,
        to_port: 0,
      }),
    ]);
  });

  // -------------------------------------------------------------------------
  // E7: the grab target, re-derived rather than inherited.
  // -------------------------------------------------------------------------

  it('E7: a press 20 world px from an Out acquires a source (it does not at the shipped 12)', () => {
    // The single accessibility change of the phase: 24px diameter -> 44px, the
    // project's own --fab-min-target floor applied to the canvas. 20 world px is
    // deliberately BETWEEN the two radii, so this case can only pass on the new one.
    const src = sourceNode(1, 2, 2);
    rig = setupRigWith({ cellsFromWorld: true }, src, sinkNode(2, 6, 5));
    rig.armWire();
    const a = anchorOf(src);

    expect(nubHitRadiusWorld(1)).toBeLessThan(20); // the shipped radius cannot reach
    expect(wireNubHitRadiusWorld(1)).toBeGreaterThan(20); // the new one can
    press(rig, { x: a.x + 20, y: a.y });

    // Acquisition is OBSERVABLE because the grabbed nub is painted: the resolved
    // source is filled, which is also how the 22px radius' two-nubs-in-range
    // ambiguity is resolved VISIBLY rather than silently.
    expect(lastTargets(rig)).toContainEqual({ ...a, filled: true });
  });

  it('E7: a press 30 world px away acquires NOTHING and leaves the tool armed', () => {
    // The discriminator: the radius widened, it did not become unbounded.
    const src = sourceNode(1, 2, 2);
    rig = setupRigWith({ cellsFromWorld: true }, src, sinkNode(2, 6, 5));
    rig.armWire();
    const a = anchorOf(src);
    press(rig, { x: a.x + 30, y: a.y });

    expect(lastTargets(rig).some((p) => p.filled)).toBe(false);
    expect(rig.cursor()).toBe('crosshair'); // still armed
  });

  it('E7/E8: after a press the source is FILLED, every In keeps its ring, other Outs drop', () => {
    // UI-SPEC 6.2 post-press row. Two Outs and one In on the board: pressing one Out
    // must leave exactly one filled Out and the In still ringed, and must darken the
    // Out the user did NOT grab, so the board stops offering a second start.
    const srcA = sourceNode(1, 2, 2);
    const srcB = sourceNode(3, 2, 8);
    const sink = sinkNode(2, 6, 5);
    rig = setupRigWith({ cellsFromWorld: true }, srcA, srcB, sink);
    rig.armWire();
    expect(lastTargets(rig)).toHaveLength(3);

    press(rig, anchorOf(srcA));
    expect(lastTargets(rig)).toEqual([
      { ...anchorOf(srcA), filled: true },
      { ...anchorOf(sink), filled: false },
    ]);
  });

  it('E8: the release repaints the RESTING set, so a user can draw several', () => {
    const src = sourceNode(1, 2, 2);
    const sink = sinkNode(2, 6, 5);
    rig = setupRigWith({ cellsFromWorld: true }, src, sink);
    rig.armWire();
    press(rig, anchorOf(src));
    up(rig, anchorOf(sink));

    expect(rig.cursor()).toBe('crosshair'); // the tool STAYS armed
    expect(lastTargets(rig)).toEqual([
      { ...anchorOf(src), filled: false },
      { ...anchorOf(sink), filled: false },
    ]);
  });

  it('E8: the ring set is RECOMPUTED on every armed move, never cached at arm time', () => {
    // scene.nodes holds DENSE render handles: on a full keyframe the host rebuilds
    // that table from zero. A list cached at arm time would paint rings at stale
    // positions with no gesture and no warning (T-66-06-02). Recomputing makes the
    // affordance a pure projection of the live scene and immune BY CONSTRUCTION.
    const src = sourceNode(1, 2, 2);
    rig = setupRigWith({ cellsFromWorld: true }, src);
    rig.armWire();
    expect(lastTargets(rig)).toHaveLength(1);

    // The keyframe remint: the table is rebuilt with the node at a NEW cell under a
    // NEW handle. Nothing about the armed tool changes and no press happens.
    rig.scene.nodes.clear();
    rig.scene.nodes.set(7, sourceNode(7, 9, 9));
    move(rig, { x: 400, y: 400 });

    expect(lastTargets(rig)).toEqual([{ ...nubAnchor(9, 9, 1), filled: false }]);
  });

  it('E8: clearSelection and destroy both clear the rings', () => {
    rig = setupRigWith({ cellsFromWorld: true }, sourceNode(1, 2, 2));
    rig.armWire();
    const before = rig.overlay.wireTargetsCleared.count;
    rig.clearSel();
    expect(rig.overlay.wireTargetsCleared.count).toBeGreaterThan(before);
    const afterClear = rig.overlay.wireTargetsCleared.count;
    rig.destroy();
    expect(rig.overlay.wireTargetsCleared.count).toBeGreaterThan(afterClear);
    rig = undefined;
  });

  it('E8: arming the BELT tool over an armed Wire tool clears the rings (IX-03)', () => {
    // Mutual exclusion is enforced in gestures.ts, not React. A superseding tool that
    // dropped wireArmed but left the rings painted would leave the board claiming a
    // wire can start somewhere while the Wire tool is put away.
    rig = setupRigWith({ cellsFromWorld: true }, sourceNode(1, 2, 2));
    rig.armWire();
    const before = rig.overlay.wireTargetsCleared.count;
    rig.armBelt();
    expect(rig.overlay.wireTargetsCleared.count).toBeGreaterThan(before);
  });

  // -------------------------------------------------------------------------
  // E9: the in-drag colour flip. Red until the pointer lands on an accepting nub.
  // -------------------------------------------------------------------------

  it('E9: the corridor is RED over empty canvas and BLUE on an accepting nub, SAME path', () => {
    // This flip IS the discoverability signal row 113 says was missing: continuous,
    // board-wide, and it needs no text. `showRoute` has zero callers before 66-01 and
    // its rig stub recorded NOTHING before this plan, so neither half of this
    // assertion could be witnessed by anything in the repository.
    const src = sourceNode(1, 2, 2); // Out at cell (2,2) facing E
    const sink = sinkNode(2, 6, 5); // In at cell (6,5) facing W
    rig = setupRigWith({ cellsFromWorld: true }, src, sink);
    rig.armWire();
    press(rig, anchorOf(src));

    // (a) Inside the target's CELL but 31 world px from its nub: outside the 22px
    // radius, so no nub is acquired and the corridor ends at the pointer's own cell.
    const off = { x: 6 * CELL + 30, y: 5 * CELL + 30 };
    expect(Math.hypot(off.x - anchorOf(sink).x, off.y - anchorOf(sink).y)).toBeGreaterThan(
      wireNubHitRadiusWorld(1),
    );
    move(rig, off);
    const red = rig.overlay.routeCalls[rig.overlay.routeCalls.length - 1];
    expect(red.valid).toBe(false);

    // (b) 6 world px from the nub: acquired, so the corridor recomputes from the
    // NUB's cell rather than the pointer's - which is the same cell, so the drawn
    // corridor does not move. Only the colour does.
    const on = { x: anchorOf(sink).x + 6, y: anchorOf(sink).y };
    move(rig, on);
    const blue = rig.overlay.routeCalls[rig.overlay.routeCalls.length - 1];
    expect(blue.valid).toBe(true);
    expect(blue.path).toEqual(red.path);

    // And it is a CORNERED corridor, not a rubber band: the source is on row 2 and
    // the target on row 5, so a Manhattan route must bend.
    const rows = new Set(blue.path.map((c) => c.cy));
    const cols = new Set(blue.path.map((c) => c.cx));
    expect(rows.size).toBeGreaterThan(1);
    expect(cols.size).toBeGreaterThan(1);
    expect(blue.path[0]).toEqual({ cx: 2, cy: 2 });
    expect(blue.path[blue.path.length - 1]).toEqual({ cx: 6, cy: 5 });
  });

  it('D1: the in-drag ghost is handed the SAME lane key the landed cable is drawn on, and it REVERSES', () => {
    // The preview half of D1. `wires.ts` displaces each cable by `lane *
    // CABLE_LANE_OFFSET` so a forward wire and its return do not draw on top of each
    // other; if the ghost did not carry the same key it would mark a corridor the
    // cable then declines to take. The key is computed from `wireRoute(...).geometry
    // .tiles` through the SAME `cableLane` the layer calls - it is a pure function of
    // the route, which is the only reason it can be evaluated during a drag, when the
    // wire has no identity at all.
    const forwardRig = setupRigWith(
      { cellsFromWorld: true },
      sourceNode(1, 2, 2),
      sinkNode(2, 6, 5),
    );
    forwardRig.armWire();
    press(forwardRig, anchorOf(sourceNode(1, 2, 2)));
    move(forwardRig, { x: anchorOf(sinkNode(2, 6, 5)).x + 6, y: anchorOf(sinkNode(2, 6, 5)).y });
    const fwd = forwardRig.overlay.routeCalls[forwardRig.overlay.routeCalls.length - 1];
    expect(fwd.path[0]).toEqual({ cx: 2, cy: 2 });
    expect(fwd.path[fwd.path.length - 1]).toEqual({ cx: 6, cy: 5 });
    // (2,2) sorts before (6,5) on x, so the ghost takes the +1 lane.
    expect(fwd.lane, 'the ghost carries the forward lane').toBe(1);
    expect(fwd.lane).toBe(cableLane(fwd.path.map((c) => ({ cell_x: c.cx, cell_y: c.cy }))));

    // The RETURN drag between the same two cells: the same corridor cells in reversed
    // order, so the key flips and the ghost takes the other lane BY CONSTRUCTION.
    const returnRig = setupRigWith(
      { cellsFromWorld: true },
      sourceNode(1, 6, 5),
      sinkNode(2, 2, 2),
    );
    returnRig.armWire();
    press(returnRig, anchorOf(sourceNode(1, 6, 5)));
    move(returnRig, { x: anchorOf(sinkNode(2, 2, 2)).x - 6, y: anchorOf(sinkNode(2, 2, 2)).y });
    const ret = returnRig.overlay.routeCalls[returnRig.overlay.routeCalls.length - 1];
    expect(ret.path[0]).toEqual({ cx: 6, cy: 5 });
    expect(ret.path[ret.path.length - 1]).toEqual({ cx: 2, cy: 2 });
    expect(ret.lane, 'the return ghost takes the OPPOSITE lane').toBe(-1);
    expect(ret.lane).toBe(-fwd.lane);
  });

  it('D-08: a hand-like drag hands the overlay the pressed nub and the acquired nub, and NO_NUB over open floor', () => {
    // CABLE-08 (plan 75-05). The preview's ends are drawn by the cable's own end geometry,
    // so what decides where they sit is which two nubs the gesture hands over. Pressed
    // off-centre and moved in sub-cell steps with a diagonal stretch, the way a hand
    // moves (memory "fixtures move one clean cell": a fixture that teleports one clean
    // step hid four shipped gesture defects).
    //   E nub of the source on (2,2): x = 2*32 + 32 - 2 + 2.5 = 96.5, y = 2*32 + 16 = 80
    //   W nub of the sink on (6,5):   x = 6*32 + 2 - 2.5     = 191.5, y = 5*32 + 16 = 176
    const SRC_NUB = { x: 96.5, y: 80, nx: 1, ny: 0, cellX: 2, cellY: 2 };
    const DST_NUB = { x: 191.5, y: 176, nx: -1, ny: 0, cellX: 6, cellY: 5 };
    rig = setupRigWith({ cellsFromWorld: true }, sourceNode(1, 2, 2), sinkNode(2, 6, 5));
    rig.armWire();
    const start = { x: 98, y: 78 }; // (+1.5, -2) off the source nub
    const end = { x: 193.5, y: 179 }; // (+2, +3) off the sink nub
    press(rig, start);

    const radius = wireNubHitRadiusWorld(1);
    const far = (p: Pt, n: Pt): boolean => Math.hypot(p.x - n.x, p.y - n.y) > radius;
    const samples: Array<{ at: Pt; call: (typeof rig.overlay.routeCalls)[number] }> = [];
    let at = { ...start };
    let diagonals = 0;
    // A move paints a corridor only once the pointer has left the source's own cell
    // (75-UI-SPEC 2.3: a one-cell route draws nothing), so a sample is kept only when the
    // move produced a fresh `showRoute` call.
    const step = (to: Pt): void => {
      if (to.x !== at.x && to.y !== at.y) diagonals++;
      at = to;
      const before = rig!.overlay.routeCalls.length;
      move(rig!, at);
      if (rig!.overlay.routeCalls.length > before) {
        samples.push({ at, call: rig!.overlay.routeCalls[rig!.overlay.routeCalls.length - 1] });
      }
    };
    const toward = (v: number, goal: number, max: number): number =>
      goal > v ? Math.min(goal, v + max) : Math.max(goal, v - max);
    // x only to the halfway column, then both axes at once, then whatever remains.
    while (at.x < 140) step({ x: toward(at.x, 140, 5.5), y: at.y });
    while (at.x !== end.x && at.y !== end.y) step({ x: toward(at.x, end.x, 3.5), y: toward(at.y, end.y, 3.5) });
    while (at.y !== end.y) step({ x: at.x, y: toward(at.y, end.y, 5.5) });
    while (at.x !== end.x) step({ x: toward(at.x, end.x, 5.5), y: at.y });

    expect(diagonals, 'the hand moved on both axes at once at least once').toBeGreaterThan(0);
    expect(samples.length, 'sub-cell steps: many painted moves, not one').toBeGreaterThan(20);
    expect(
      samples.some(({ at: p }) => p.x !== start.x && p.y !== start.y && p.x < end.x && p.y < end.y),
      'a painted sample on the diagonal stretch',
    ).toBe(true);
    for (const { at: p, call } of samples) {
      expect(call.nubs.from, `the pressed nub rides every call; pointer at (${p.x},${p.y})`).toEqual(SRC_NUB);
    }
    const open = samples.filter(({ at: p }) => far(p, SRC_NUB) && far(p, DST_NUB));
    expect(open.length, 'some samples were over open floor').toBeGreaterThan(0);
    for (const { at: p, call } of open) {
      expect(call.nubs.to, `over open floor the far end is NO_NUB; pointer at (${p.x},${p.y})`).toBeNull();
    }
    const last = samples[samples.length - 1].call;
    expect(last.nubs.to, 'held over the sink, the far end is its nub').toEqual(DST_NUB);
    expect(last.valid).toBe(true);
    up(rig, end);
  });

  it('E9: no route is painted before a source is acquired (an armed move alone is not a drag)', () => {
    rig = setupRigWith({ cellsFromWorld: true }, sourceNode(1, 2, 2), sinkNode(2, 6, 5));
    rig.armWire();
    move(rig, { x: 200, y: 200 });
    expect(rig.overlay.routeCalls).toHaveLength(0);
  });
});

// ===========================================================================
// The press side (plan 66-09, WIRE-02; the press rule amended by plan 75-07, D-12).
// The decision of 2026-08-26, and it is a SPLIT rather than one behaviour.
//
// As UI-SPEC 4.2 was first written THREE presses produced nothing at all - no
// marker, no flash, no message: an electrical In nub (literally the gesture
// WINDOWS row 113 reports, "the user tried the intuitive inverse"), a MECHANICAL Out
// nub, and a Fault nub. The phase whose SC5 is "no silently inert gesture" may
// not ship one in its own press handler.
//
// THE RULE THESE CASES PIN: emission is preferred wherever a command CAN be
// formed, and the client authors a message ONLY where no command exists to
// refuse.
//
//   - an ELECTRICAL Role::Out press starts the drag with the accepting marker. One
//     anywhere in range wins over any nearer port.
//   - a press whose nearest port takes belts only (any role: a Router's Out or In, a
//     Fault drain) forms NO command since D-12 (2026-10-06, "Fix it in 75";
//     the report from the real binary, "dragging wire from router doesn't work, becomes
//     red whatever I do"). It gets the reject flash over THAT port's cell and the
//     client sentence `CLIENT_REFUSAL_COPY.BeltOnlyPort`; no marker, no corridor,
//     and the release sends nothing. From 66-09 to 75-07 a MECHANICAL Out started
//     the drag instead and the release let the host say MediumMismatch: P1 and P5
//     pinned that, and were rewritten in the open by 75-07.
//   - an ELECTRICAL Role::In or Fault press alone still gets the WHERE-only flash
//     and nothing else: there is no source to name and no one cause that is true in
//     a sentence. Both copy tables are closed, with no default arm BY DESIGN.
// ===========================================================================
describe('wire press and release reject states (WIRE-02, 66-09)', () => {
  const ELEC = MEDIUM_ELECTRICAL;
  const MECH = MEDIUM_MECHANICAL;

  /** A 1x1 node carrying ONE port at its own cell. */
  const one = (
    id: number,
    cx: number,
    cy: number,
    side: number,
    role: number,
    medium: number,
  ): NodeView =>
    node({
      id,
      kind: machine_kind.ROUTER,
      cell_x: cx,
      cell_y: cy,
      ports: [{ index: 0, cell_x: cx, cell_y: cy, side, role, medium }],
    });

  /** An ELECTRICAL Out, the source a wire is meant to start from. */
  const elecOut = (id: number, cx: number, cy: number): NodeView => one(id, cx, cy, 1, 1, ELEC);
  /** A MECHANICAL Out: a source a DrawWire CAN name and the host refuses. */
  const mechOut = (id: number, cx: number, cy: number): NodeView => one(id, cx, cy, 1, 1, MECH);
  /** An ELECTRICAL In, the target a wire lands on. */
  const elecIn = (id: number, cx: number, cy: number): NodeView => one(id, cx, cy, 3, 0, ELEC);
  /** A MECHANICAL In: in range, role-legal, and the ranker rejects it. */
  const mechIn = (id: number, cx: number, cy: number): NodeView => one(id, cx, cy, 3, 0, MECH);
  /** A Fault port (role 2). Never a wire terminal at either end. */
  const faultPort = (id: number, cx: number, cy: number): NodeView => one(id, cx, cy, 2, 2, ELEC);

  const anchorOf = (n: NodeView): Pt =>
    nubAnchor(n.ports[0].cell_x, n.ports[0].cell_y, n.ports[0].side);

  const press = (r: Rig, pt: Pt): void => {
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, clientX: pt.x, clientY: pt.y });
  };
  const move = (r: Rig, pt: Pt): void => {
    r.win.fire('pointermove', { target: r.canvas, clientX: pt.x, clientY: pt.y });
  };
  const up = (r: Rig, pt: Pt): void => {
    r.win.fire('pointerup', { button: 0, target: r.canvas, clientX: pt.x, clientY: pt.y });
  };
  const lastTargets = (r: Rig): Array<{ x: number; y: number; filled: boolean }> =>
    r.overlay.wireTargetCalls[r.overlay.wireTargetCalls.length - 1];
  /** The one-cell footprint every reject flash in this file carries. */
  const CELL_1x1 = { w: 1, h: 1, rot: 0 };

  // -------------------------------------------------------------------------
  // P: the press half of the split.
  // -------------------------------------------------------------------------

  /** The press point a hand lands on: off the anchor, well inside the 22 px wire radius. */
  const offCentre = (pt: Pt): Pt => ({ x: pt.x + 3, y: pt.y - 2 });

  /**
   * Walk the pointer from `from` to `to` the way a hand does: steps of at most 5.5 px per
   * axis, x only to the halfway column, then both axes at once, then whatever remains.
   * Returns how many steps moved on both axes, so a case can assert the diagonal ran.
   */
  const walk = (r: Rig, from: Pt, to: Pt): number => {
    const toward = (v: number, goal: number, max: number): number =>
      goal > v ? Math.min(goal, v + max) : Math.max(goal, v - max);
    let p = { ...from };
    let diagonals = 0;
    const step = (n: Pt): void => {
      if (n.x !== p.x && n.y !== p.y) diagonals++;
      p = n;
      move(r, p);
    };
    const xMid = from.x + (to.x - from.x) / 2;
    while (p.x !== xMid) step({ x: toward(p.x, xMid, 5.5), y: p.y });
    while (p.x !== to.x && p.y !== to.y) step({ x: toward(p.x, to.x, 3.5), y: toward(p.y, to.y, 3.5) });
    while (p.y !== to.y) step({ x: p.x, y: toward(p.y, to.y, 5.5) });
    while (p.x !== to.x) step({ x: toward(p.x, to.x, 5.5), y: p.y });
    return diagonals;
  };

  it('P1: a MECHANICAL Out press is refused at the press, in words, and starts no drag (D-12)', () => {
    // REWRITTEN BY PLAN 75-07 (D-12). Was: "a MECHANICAL Out press STARTS the drag and
    // paints its marker NON-accepting", which pinned a red drag that could only ever
    // end in the host's MediumMismatch. A port that only takes belts can be neither a
    // wire's source nor its target, so the press forms no command and is answered here:
    // the flash over THAT port's cell and the BeltOnlyPort sentence.
    const src = mechOut(1, 2, 2);
    rig = setupRigWith({ cellsFromWorld: true }, src, elecIn(2, 6, 5));
    rig.armWire();
    const a = anchorOf(src);

    press(rig, offCentre(a));

    expect(rig.overlay.rejectFlashCalls).toEqual([{ cell: { cx: 2, cy: 2 }, dims: CELL_1x1 }]);
    expect(rig.clientRefusals).toEqual(['BeltOnlyPort']);
    // No marker and no source: the resting ring set carries no fill.
    expect(rig.overlay.nubRingCalls).toHaveLength(0);
    expect(lastTargets(rig).some((p) => p.filled)).toBe(false);
    // A hand's drag, sub-cell and diagonal, paints no corridor at any step.
    const diagonals = walk(rig, offCentre(a), { x: a.x + 70, y: a.y + 45 });
    expect(diagonals, 'the walk moved on both axes at once').toBeGreaterThan(0);
    expect(rig.overlay.routeCalls).toHaveLength(0);
    expect(rig.sent).toHaveLength(0);
    expect(rig.cursor()).toBe('crosshair'); // and the tool stays armed
  });

  it('P1: the release after a refused MECHANICAL Out press sends no frame, even on an ACCEPTING In (D-12)', () => {
    // REWRITTEN BY PLAN 75-07 (D-12). Was: "the MECHANICAL Out release EMITS, so the
    // host answers MediumMismatch in words". The host's sentence is now reached only
    // from a belt-only TARGET (see R1 and `18-refusal.spec.ts`); from a belt-only
    // source the client already said why at the press, and a second message on the
    // release would be the same refusal said twice.
    const src = mechOut(1, 2, 2);
    const sink = elecIn(2, 6, 5);
    rig = setupRigWith({ cellsFromWorld: true }, src, sink);
    rig.armWire();
    const from = offCentre(anchorOf(src));
    const to = { x: anchorOf(sink).x - 2, y: anchorOf(sink).y + 3 };

    press(rig, from);
    walk(rig, from, to);
    up(rig, to);

    expect(rig.sent).toHaveLength(0);
    expect(rig.overlay.routeCalls).toHaveLength(0);
    // One press, one sentence, one flash: the release adds neither.
    expect(rig.clientRefusals).toEqual(['BeltOnlyPort']);
    expect(rig.overlay.rejectFlashCalls).toEqual([{ cell: { cx: 2, cy: 2 }, dims: CELL_1x1 }]);
  });

  it('P1: an ELECTRICAL Out press paints its marker ACCEPTING and raises no sentence (the discriminator)', () => {
    // Without this the two refusals above could pass on a handler that refused every
    // Out. Kept from 66-09; since 75-07 it also pins that a valid source says nothing.
    const src = elecOut(1, 2, 2);
    rig = setupRigWith({ cellsFromWorld: true }, src, elecIn(2, 6, 5));
    rig.armWire();

    press(rig, offCentre(anchorOf(src)));

    expect(rig.overlay.nubRingCalls).toContainEqual({ pt: anchorOf(src), armed: true });
    expect(rig.overlay.rejectFlashCalls).toHaveLength(0);
    expect(rig.clientRefusals).toEqual([]);
  });

  it('P2: a press on an ELECTRICAL In fires the reject flash over THAT nub cell', () => {
    // WINDOWS row 113's own gesture, the intuitive inverse. There is no source to
    // name here, so no command can be formed and the host cannot be asked. The
    // flash says WHERE and carries no reason (UI-SPEC 6.4 row 3 idiom).
    const sink = elecIn(2, 6, 5);
    rig = setupRigWith({ cellsFromWorld: true }, elecOut(1, 2, 2), sink);
    rig.armWire();

    press(rig, anchorOf(sink));

    expect(rig.overlay.rejectFlashCalls).toEqual([{ cell: { cx: 6, cy: 5 }, dims: CELL_1x1 }]);
    // No source was recorded: no fill in the ring set, and a move paints no route.
    expect(lastTargets(rig).some((p) => p.filled)).toBe(false);
    move(rig, { x: 300, y: 300 });
    expect(rig.overlay.routeCalls).toHaveLength(0);
    expect(rig.sent).toHaveLength(0);
    expect(rig.cursor()).toBe('crosshair'); // and the tool stays armed
  });

  it('P2: a press on a FAULT nub behaves exactly as the In press does', () => {
    // Role 2 is deliberately not accepted on the source side by the host
    // (command.rs step 4), so it is not a source either. Same where-only flash.
    const fault = faultPort(3, 4, 4);
    rig = setupRigWith({ cellsFromWorld: true }, elecOut(1, 2, 2), fault);
    rig.armWire();

    press(rig, anchorOf(fault));

    expect(rig.overlay.rejectFlashCalls).toEqual([{ cell: { cx: 4, cy: 4 }, dims: CELL_1x1 }]);
    expect(lastTargets(rig).some((p) => p.filled)).toBe(false);
    expect(rig.sent).toHaveLength(0);
  });

  it('P3: a press with NO nub in range stays a silent no-op, and the tool stays armed', () => {
    // The discriminator for the two flash cases above: open floor is not a nub, so
    // there is nothing to point at. The red corridor is not owed one either,
    // because no drag has started.
    rig = setupRigWith({ cellsFromWorld: true }, elecOut(1, 2, 2), elecIn(2, 6, 5));
    rig.armWire();

    press(rig, { x: 600, y: 600 });

    expect(rig.overlay.rejectFlashCalls).toHaveLength(0);
    expect(rig.overlay.nubRingCalls).toHaveLength(0);
    expect(rig.sent).toHaveLength(0);
    expect(rig.cursor()).toBe('crosshair');
  });

  it('P4: an Out in range wins over a nearer In, and the press starts a drag', () => {
    // The press-side ranker picks WHAT, exactly as the release-side one does. With
    // both an In and an Out reachable, the Out is the source and no flash fires -
    // the flash arm is "no Out in range at all", never "the nearest hit is an In".
    const out = elecOut(1, 3, 3); // Out at cell (3,3) facing E
    const inn = one(2, 3, 4, 0, 0, ELEC); // In at cell (3,4) facing N
    rig = setupRigWith({ cellsFromWorld: true }, out, inn);
    rig.armWire();
    const ain = anchorOf(inn);
    const aout = anchorOf(out);
    // 70% of the way from the Out to the In: NEAREST the In, with the Out still
    // inside the 22px radius. Derived from the two anchors, never transcribed.
    const p = { x: aout.x + 0.7 * (ain.x - aout.x), y: aout.y + 0.7 * (ain.y - aout.y) };
    expect(Math.hypot(p.x - aout.x, p.y - aout.y)).toBeLessThan(wireNubHitRadiusWorld(1));
    expect(Math.hypot(p.x - ain.x, p.y - ain.y)).toBeLessThan(
      Math.hypot(p.x - aout.x, p.y - aout.y),
    );

    press(rig, p);

    expect(rig.overlay.rejectFlashCalls).toHaveLength(0);
    expect(lastTargets(rig)).toContainEqual({ ...aout, filled: true });
  });

  it('P5: a MECHANICAL Out never becomes a source, so no corridor is drawn even over an ACCEPTING In (D-12)', () => {
    // REWRITTEN BY PLAN 75-07 (D-12). Was: "a MECHANICAL source keeps the corridor RED
    // even over an ACCEPTING In" - the red drag that was reported ("becomes red whatever I
    // do"). A mechanical Out is no longer acquired, so there is no corridor of either
    // colour; the electrical half below still proves the same move paints blue from a
    // real source, so this is not passing because nothing ever paints.
    const src = mechOut(1, 2, 2);
    const sink = elecIn(2, 6, 5);
    rig = setupRigWith({ cellsFromWorld: true }, src, sink);
    rig.armWire();
    press(rig, offCentre(anchorOf(src)));
    walk(rig, offCentre(anchorOf(src)), { x: anchorOf(sink).x + 6, y: anchorOf(sink).y });
    expect(rig.overlay.routeCalls).toHaveLength(0);

    rig.destroy();
    const src2 = elecOut(1, 2, 2);
    rig = setupRigWith({ cellsFromWorld: true }, src2, sink);
    rig.armWire();
    press(rig, offCentre(anchorOf(src2)));
    walk(rig, offCentre(anchorOf(src2)), { x: anchorOf(sink).x + 6, y: anchorOf(sink).y });
    expect(rig.overlay.routeCalls[rig.overlay.routeCalls.length - 1].valid).toBe(true);
  });

  it('P6: a MECHANICAL In pressed alone gets the flash over its cell AND the sentence (D-12, a Router In)', () => {
    const sink = mechIn(2, 6, 5);
    rig = setupRigWith({ cellsFromWorld: true }, elecOut(1, 2, 2), sink);
    rig.armWire();

    press(rig, offCentre(anchorOf(sink)));

    expect(rig.overlay.rejectFlashCalls).toEqual([{ cell: { cx: 6, cy: 5 }, dims: CELL_1x1 }]);
    expect(rig.clientRefusals).toEqual(['BeltOnlyPort']);
    expect(lastTargets(rig).some((p) => p.filled)).toBe(false);
    up(rig, offCentre(anchorOf(sink)));
    expect(rig.sent).toHaveLength(0);
  });

  it('P6: a MECHANICAL Fault drain pressed alone gets the sentence, and its release sends no frame (D-12)', () => {
    const drain = one(3, 4, 4, 2, 2, MECH);
    const sink = elecIn(2, 6, 5);
    rig = setupRigWith({ cellsFromWorld: true }, elecOut(1, 2, 2), drain, sink);
    rig.armWire();
    const from = offCentre(anchorOf(drain));
    const to = { x: anchorOf(sink).x - 2, y: anchorOf(sink).y + 3 };

    press(rig, from);
    walk(rig, from, to);
    up(rig, to);

    expect(rig.overlay.rejectFlashCalls).toEqual([{ cell: { cx: 4, cy: 4 }, dims: CELL_1x1 }]);
    expect(rig.clientRefusals).toEqual(['BeltOnlyPort']);
    expect(rig.overlay.routeCalls).toHaveLength(0);
    expect(rig.sent).toHaveLength(0);
  });

  it('P7: an ELECTRICAL In pressed alone gets the flash and NO sentence', () => {
    // UI-SPEC 5.1: no cause is true in a sentence there, so the where-only answer stays.
    const sink = elecIn(2, 6, 5);
    rig = setupRigWith({ cellsFromWorld: true }, elecOut(1, 2, 2), sink);
    rig.armWire();

    press(rig, offCentre(anchorOf(sink)));

    expect(rig.overlay.rejectFlashCalls).toEqual([{ cell: { cx: 6, cy: 5 }, dims: CELL_1x1 }]);
    expect(rig.clientRefusals).toEqual([]);
  });

  it('P8: an ELECTRICAL Out in range beats a NEARER mechanical port, so the refusal never steals a valid press (T-75-24)', () => {
    const out = elecOut(1, 3, 3); // electrical Out at (3,3) facing E
    const mech = one(2, 3, 4, 0, 0, MECH); // mechanical In at (3,4) facing N
    rig = setupRigWith({ cellsFromWorld: true }, out, mech);
    rig.armWire();
    const aout = anchorOf(out);
    const amech = anchorOf(mech);
    // 70% of the way from the Out to the mechanical port: NEAREST the mechanical one,
    // with the Out still inside the 22 px radius. Derived from the anchors.
    const p = { x: aout.x + 0.7 * (amech.x - aout.x), y: aout.y + 0.7 * (amech.y - aout.y) };
    expect(Math.hypot(p.x - aout.x, p.y - aout.y)).toBeLessThan(wireNubHitRadiusWorld(1));
    expect(Math.hypot(p.x - amech.x, p.y - amech.y)).toBeLessThan(Math.hypot(p.x - aout.x, p.y - aout.y));

    press(rig, p);

    expect(rig.clientRefusals).toEqual([]);
    expect(rig.overlay.rejectFlashCalls).toHaveLength(0);
    expect(rig.overlay.nubRingCalls).toContainEqual({ pt: aout, armed: true });
    expect(lastTargets(rig)).toContainEqual({ ...aout, filled: true });
  });

  it('P9: the flash lands on the port the sentence describes, the NEAREST, never another port in range', () => {
    const mech = one(1, 3, 3, 1, 0, MECH); // mechanical In at (3,3) facing E
    const elec = one(2, 3, 4, 0, 0, ELEC); // electrical In at (3,4) facing N
    const am = anchorOf(mech);
    const ae = anchorOf(elec);
    const toward = (k: number): Pt => ({ x: am.x + k * (ae.x - am.x), y: am.y + k * (ae.y - am.y) });
    for (const k of [0.3, 0.7]) {
      const q = toward(k);
      expect(Math.hypot(q.x - am.x, q.y - am.y)).toBeLessThan(wireNubHitRadiusWorld(1));
      expect(Math.hypot(q.x - ae.x, q.y - ae.y)).toBeLessThan(wireNubHitRadiusWorld(1));
    }

    // Nearest the MECHANICAL In: flash over (3,3) and the sentence.
    rig = setupRigWith({ cellsFromWorld: true }, mech, elec);
    rig.armWire();
    press(rig, toward(0.3));
    expect(rig.overlay.rejectFlashCalls).toEqual([{ cell: { cx: 3, cy: 3 }, dims: CELL_1x1 }]);
    expect(rig.clientRefusals).toEqual(['BeltOnlyPort']);

    // Nearest the ELECTRICAL In: flash over (3,4) and NO sentence, though a belt-only
    // port is in range. The sentence never describes a port the flash does not mark.
    rig.destroy();
    rig = setupRigWith({ cellsFromWorld: true }, mech, elec);
    rig.armWire();
    press(rig, toward(0.7));
    expect(rig.overlay.rejectFlashCalls).toEqual([{ cell: { cx: 3, cy: 4 }, dims: CELL_1x1 }]);
    expect(rig.clientRefusals).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // R: the release half. Emit either way, flash where the user aimed.
  //
  // THE RANKER PICKS WHAT, NEVER WHETHER (Phase 64, D-07/D-08). Client-side
  // re-validation before emit was REMOVED because a locally-swallowed gesture
  // produced "no belt dock, no flash, no log line". These cases are what can see
  // an eighth suppression site growing back.
  // -------------------------------------------------------------------------

  it('R1: a release the ranker REJECTS still EMITS, and flashes over that nub cell', () => {
    // The exact belt precedent (WR-02): a belt released squarely on an electrical
    // In records and emits the dock, fires the flash over the nub cell, and lets
    // the host answer. This is that shape with the mediums the other way round.
    const src = elecOut(1, 2, 2);
    const sink = mechIn(2, 6, 5);
    rig = setupRigWith({ cellsFromWorld: true }, src, sink);
    rig.armWire();

    press(rig, anchorOf(src));
    up(rig, anchorOf(sink));

    // ONE DrawWire, naming the two ports the pointer named, verbatim.
    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({
        kind: 'DrawWire',
        from_node: 1,
        from_port: 0,
        to_node: 2,
        to_port: 0,
      }),
    ]);
    // ... and the WHERE, over the nub the release addressed. The WHY is the host's
    // typed tag rendered by RefusalMessage; no sentence is minted here.
    expect(rig.overlay.rejectFlashCalls).toEqual([{ cell: { cx: 6, cy: 5 }, dims: CELL_1x1 }]);
  });

  it('R2: a release the ranker ACCEPTS emits and does NOT flash', () => {
    // The discriminator for R1: the client predicted accept, so it owes no WHERE.
    const src = elecOut(1, 2, 2);
    const sink = elecIn(2, 6, 5);
    rig = setupRigWith({ cellsFromWorld: true }, src, sink);
    rig.armWire();

    press(rig, anchorOf(src));
    up(rig, anchorOf(sink));

    expect(rig.sent).toHaveLength(1);
    expect(rig.overlay.rejectFlashCalls).toHaveLength(0);
  });

  it('R3: a release on NOTHING emits nothing and flashes over the released cell', () => {
    // The row WINDOWS row 113 is about, and it is no longer silent. No command:
    // there is no port to name and forging one would be the client inventing a
    // target. The feedback is not one event - the corridor was RED for every frame
    // of the drag, and the release adds the 180ms fault flash over the cell.
    const src = elecOut(1, 2, 2);
    rig = setupRigWith({ cellsFromWorld: true }, src, elecIn(2, 6, 5));
    rig.armWire();

    press(rig, anchorOf(src));
    up(rig, { x: 10 * CELL + 5, y: 7 * CELL + 5 });

    expect(rig.sent).toHaveLength(0);
    expect(rig.overlay.rejectFlashCalls).toEqual([{ cell: { cx: 10, cy: 7 }, dims: CELL_1x1 }]);
  });

  it('R4: every release clears the corridor and the source marker, and keeps the tool armed', () => {
    // Three releases, one per row of UI-SPEC 6.4, and none of them may leave a
    // corridor or a grabbed-source marker painted over an idle board.
    const src = elecOut(1, 2, 2);
    const sink = elecIn(2, 6, 5);
    rig = setupRigWith({ cellsFromWorld: true }, src, sink);
    rig.armWire();

    for (const target of [anchorOf(sink), { x: 10 * CELL + 5, y: 7 * CELL + 5 }]) {
      press(rig, anchorOf(src));
      move(rig, { x: 200, y: 200 });
      // Counted AFTER the press, so the press's own teardown cannot satisfy this.
      const routes = rig.overlay.routeCleared.count;
      const rings = rig.overlay.nubRingCleared.count;
      up(rig, target);
      expect(rig.overlay.routeCleared.count).toBeGreaterThan(routes);
      expect(rig.overlay.nubRingCleared.count).toBeGreaterThan(rings);
      expect(rig.cursor()).toBe('crosshair'); // the tool STAYS armed
      expect(lastTargets(rig).some((p) => p.filled)).toBe(false);
    }
  });

  it('R5: a release on a nub the ranker rejects flashes over the NUB cell, not the pointer cell', () => {
    // The discriminator between R1 and R3. Releasing inside the 22px radius but in
    // a DIFFERENT cell from the nub must still point at the nub, because the nub is
    // what the command named.
    const src = elecOut(1, 2, 2);
    const sink = mechIn(2, 6, 5); // In at cell (6,5) facing W, anchor x = 6*CELL - 0.5
    rig = setupRigWith({ cellsFromWorld: true }, src, sink);
    rig.armWire();
    const a = anchorOf(sink);
    const off = { x: a.x - 8, y: a.y }; // still in range, one cell to the WEST
    expect(Math.floor(off.x / CELL)).not.toBe(6);
    expect(Math.hypot(off.x - a.x, off.y - a.y)).toBeLessThan(wireNubHitRadiusWorld(1));

    press(rig, anchorOf(src));
    up(rig, off);

    expect(rig.sent).toHaveLength(1);
    expect(rig.overlay.rejectFlashCalls).toEqual([{ cell: { cx: 6, cy: 5 }, dims: CELL_1x1 }]);
  });

  it('R6: a release on an electrical OUT nub still EMITS and flashes over that nub cell (CR-01)', () => {
    // The release ranker used to filter the hit set to Role::In before ranking, so a
    // release squarely on an Out nub found an empty hit set and emitted NOTHING - the
    // exact silent-swallow shape 66-CONTEXT's press-side amendment outlaws. A command
    // CAN be formed here (the target's node id and port index exist for an Out exactly
    // as they do for an In), so it IS formed and the host answers step 4 in its own
    // words. Reuses R1's geometry: source at (2,2), target at (6,5).
    const src = elecOut(1, 2, 2);
    const target = elecOut(2, 6, 5);
    rig = setupRigWith({ cellsFromWorld: true }, src, target);
    rig.armWire();

    press(rig, anchorOf(src));
    up(rig, anchorOf(target));

    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({
        kind: 'DrawWire',
        from_node: 1,
        from_port: 0,
        to_node: 2,
        to_port: 0,
      }),
    ]);
    expect(rig.overlay.rejectFlashCalls).toEqual([{ cell: { cx: 6, cy: 5 }, dims: CELL_1x1 }]);
  });

  it('R7: a release on a FAULT nub does the same (the host answers IncompatiblePorts) (CR-01)', () => {
    // Role 2 is never a wire terminal at either end, but a command CAN still be formed
    // against it - the same reasoning as R6, the other role the old filter swallowed.
    // Reuses P2-fault's own fixture (faultPort(3, 4, 4)) as the release target.
    const src = elecOut(1, 2, 2);
    const fault = faultPort(3, 4, 4);
    rig = setupRigWith({ cellsFromWorld: true }, src, fault);
    rig.armWire();

    press(rig, anchorOf(src));
    up(rig, anchorOf(fault));

    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({
        kind: 'DrawWire',
        from_node: 1,
        from_port: 0,
        to_node: 3,
        to_port: 0,
      }),
    ]);
    expect(rig.overlay.rejectFlashCalls).toEqual([{ cell: { cx: 4, cy: 4 }, dims: CELL_1x1 }]);
  });
});

// ===========================================================================
// Pointer precedence while the Wire tool is armed (UI-SPEC 4.5, BINDING).
//
// TEST-ONLY BY CONSTRUCTION, AND THAT IS THE POINT. The contract is free because
// the shape is already shipped: `beltArmed` is the literal FIRST statement of all
// three pointer entry points and each returns BEFORE the rotateHandleHit /
// hitHandle ladder, so while Belt is armed the belt handles and the rotate handle
// are inert without anybody writing a guard. `wireArmed` takes the identical shape
// at the identical three sites. A wire branch placed anywhere except at the top
// inherits the collision instead of avoiding it - which is why the proof of these
// cases is MOVING the branch below the ladder and watching them redden, not
// reading the code.
//
// It matters more since 66-06 than it did before: widening the electrical grab
// radius from 12 to 22 world px makes a press landing in BOTH regions likelier.
// Nothing in the repository could distinguish the two outcomes until the Wire
// tool existed.
// ===========================================================================
describe('wire tool pointer precedence (WIRE-02, UI-SPEC 4.5)', () => {
  const ELEC = MEDIUM_ELECTRICAL;

  /** A 1x1 node carrying one electrical Out at cell (2,2) facing E. */
  const outNode = (): NodeView =>
    node({
      id: 1,
      kind: machine_kind.ROUTER,
      cell_x: 2,
      cell_y: 2,
      ports: [{ index: 0, cell_x: 2, cell_y: 2, side: 1, role: 1, medium: ELEC }],
    });

  const tile = (cx: number, cy: number): TileView => ({
    cell_x: cx,
    cell_y: cy,
    kind: { Straight: { axis: 0 } },
  });

  /**
   * An undocked belt running (3,2)->(5,2). Its TAIL handle sits at the tile
   * centre of (3,2) = (112,80), which is 15.5 world px from the Out nub anchor at
   * (96.5,80) - so a single press can be inside BOTH the 12px handle radius and
   * the 22px wire radius. That overlap is the whole subject of this block.
   */
  const overlapBelt = (): BeltView => ({
    id: 3,
    latency: 1,
    fill: 0,
    items: [],
    tiles: [tile(3, 2), tile(4, 2), tile(5, 2)],
    docks: [],
    ticks_per_slot: 1,
  });

  /** Centre-of-cell client point under the cellsFromWorld rig. */
  const cellPt = (cx: number, cy: number): Pt => ({
    x: cx * CELL + CELL / 2,
    y: cy * CELL + CELL / 2,
  });
  const press = (r: Rig, pt: Pt): void => {
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, clientX: pt.x, clientY: pt.y });
  };
  const move = (r: Rig, pt: Pt): void => {
    r.win.fire('pointermove', { target: r.canvas, clientX: pt.x, clientY: pt.y });
  };
  const up = (r: Rig, pt: Pt): void => {
    r.win.fire('pointerup', { button: 0, target: r.canvas, clientX: pt.x, clientY: pt.y });
  };
  /** Select the belt: press-then-release on one of its tiles, nothing armed. */
  const selectBelt = (r: Rig): void => {
    press(r, cellPt(4, 2));
    up(r, cellPt(4, 2));
  };

  it('a press inside BOTH a belt handle and a wire nub starts a WIRE, never a handle drag', () => {
    const out = outNode();
    const belt = overlapBelt();
    rig = setupRigWith({ cellsFromWorld: true }, out);
    rig.scene.belts.set(belt.id, belt);
    selectBelt(rig);
    // A belt selection reads null through selectedId() by design (the chrome
    // selection is node-scoped, CTRL-01); the handles being PAINTED is the
    // observable that the belt is selected and its endpoint grabs exist.
    expect(rig.overlay.beltHandleCalls.length).toBeGreaterThan(0);

    const nub = nubAnchor(2, 2, 1); // (96.5, 80)
    const handle = beltHandlePoints(rig.scene.nodes, rig.scene.belts, belt).tail; // (112, 80)
    // The press point is inside BOTH regions. Both facts are asserted, so this case
    // cannot pass by having quietly drifted out of one of them.
    const p = { x: (nub.x + handle.x) / 2, y: nub.y };
    expect(Math.hypot(p.x - nub.x, p.y - nub.y)).toBeLessThan(wireNubHitRadiusWorld(1));
    expect(Math.hypot(p.x - handle.x, p.y - handle.y)).toBeLessThan(nubHitRadiusWorld(1));

    rig.armWire();
    const draggedBefore = rig.overlay.draggedHandleCalls.length;
    press(rig, p);

    // (c) NO belt handle drag started. Checked FIRST and on the cursor, because a
    // handle grab is the thing that has to NOT happen and the cursor is its
    // immediate, unmaskable signature: `hitHandle` sets 'grabbing' inside the press
    // itself, while an armed Wire tool holds 'crosshair'.
    expect(rig.cursor()).toBe('crosshair');
    move(rig, { x: 300, y: 300 });
    // ... and the dragged handle was never painted either. `showDraggedHandle` fires
    // on the MOVE, so this is checked after one.
    expect(rig.overlay.draggedHandleCalls.length).toBe(draggedBefore);
    // (a) a wire source WAS acquired: the grabbed nub is painted filled.
    const targets = rig.overlay.wireTargetCalls[rig.overlay.wireTargetCalls.length - 1];
    expect(targets).toContainEqual({ ...nub, filled: true });
    // (b) and the corridor is painted.
    expect(rig.overlay.routeCalls.length).toBeGreaterThan(0);
    // ... and the release emits a DrawWire, never a Dock.
    rig.sent.length = 0;
    up(rig, { x: 300, y: 300 });
    expect(rig.sent).toHaveLength(0); // released on nothing: no command at all
    expect(rig.panState.enabled).toBe(false); // still armed, pan still suspended
  });

  it('the SAME press with the Wire tool put away DOES start a handle drag (the discriminator)', () => {
    // Without this, the case above could pass on a rig where the handle was never
    // reachable in the first place. The overlap is real: unarmed, the handle wins.
    const belt = overlapBelt();
    rig = setupRigWith({ cellsFromWorld: true }, outNode());
    rig.scene.belts.set(belt.id, belt);
    selectBelt(rig);

    const nub = nubAnchor(2, 2, 1);
    const handle = beltHandlePoints(rig.scene.nodes, rig.scene.belts, belt).tail;
    const p = { x: (nub.x + handle.x) / 2, y: nub.y };

    press(rig, p);
    move(rig, { x: 150, y: 90 });

    expect(rig.overlay.draggedHandleCalls.length).toBeGreaterThan(0);
  });

  it('the rotate handle does not hover or press while the Wire tool is armed', () => {
    rig = setupRigWith({ cellsFromWorld: true }, outNode());
    // Select the node, then park its rotate handle at a known point.
    press(rig, cellPt(2, 2));
    up(rig, cellPt(2, 2));
    expect(rig.selectedId()).toBe(1);
    const handlePt = { x: 300, y: 90 };
    rig.overlay.rotateCenter.pt = handlePt;

    rig.armWire();
    const hoversBefore = rig.overlay.rotateHoverCalls.length;
    move(rig, { x: handlePt.x + 3, y: handlePt.y });
    press(rig, handlePt);
    up(rig, handlePt);

    expect(rig.overlay.rotateHoverCalls.length).toBe(hoversBefore); // no hover call
    expect(rig.sent).toHaveLength(0); // and no Rotate emitted
  });

  it('the SAME rotate-handle press with the Wire tool put away DOES emit a Rotate', () => {
    // The discriminator for the case above: the handle is genuinely reachable in
    // this rig, so "no Rotate" means the armed tool suppressed it rather than the
    // fixture never having offered one.
    rig = setupRigWith({ cellsFromWorld: true }, outNode());
    press(rig, cellPt(2, 2));
    up(rig, cellPt(2, 2));
    const handlePt = { x: 300, y: 90 };
    rig.overlay.rotateCenter.pt = handlePt;

    move(rig, { x: handlePt.x + 3, y: handlePt.y });
    press(rig, handlePt);
    up(rig, handlePt);

    expect(rig.overlay.rotateHoverCalls.at(-1)).toBe(true);
    expect(rig.sent).toHaveLength(1);
  });

  it('Escape disarms the Wire tool FIRST, before clearing a selection', () => {
    // IX-07 disarm-first ordering. 66-01 wired the wireArmed arm into the ladder
    // and asserted nothing about it; this is that arm's first witness.
    rig = setupRigWith({ cellsFromWorld: true }, outNode());
    press(rig, cellPt(2, 2));
    up(rig, cellPt(2, 2));
    expect(rig.selectedId()).toBe(1);
    rig.armWire();

    rig.win.fire('keydown', { key: 'Escape', preventDefault: () => {} });

    expect(rig.armedCalls.at(-1)).toBeNull(); // the tool disarmed ...
    expect(rig.selectedId()).toBe(1); // ... and the selection survived THIS press
    expect(rig.escapeFallback.count).toBe(0);

    // A second Escape, nothing armed now, clears the selection.
    rig.win.fire('keydown', { key: 'Escape', preventDefault: () => {} });
    expect(rig.selectedId()).toBeNull();
  });

  // MOVED BY PLAN 89-07 (D-11, "the wire draw gets the same treatment where it shares the code").
  // This case used to be `right-click cancels the in-flight wire drag, on the SHIPPED Belt terms
  // (IX-08)`, which pinned a right press mid-drag putting the Wire tool away, because the shipped
  // Belt tool did. D-11 changed the Belt terms: only the right button cancels, and the in-flight
  // path before the tool. The wire follows: a right press with a source held drops the source and
  // keeps the tool; a right press with none still puts the tool away (IX-08's context-menu guard).
  it('right-click cancels the in-flight wire source and keeps the tool; with no source it puts the tool down (IX-08, D-11)', () => {
    const out = outNode();
    rig = setupRigWith({ cellsFromWorld: true }, out);
    rig.armWire();
    press(rig, nubAnchor(2, 2, 1)); // a drag IS in flight

    rig.canvas.fire('pointerdown', { button: 2, target: rig.canvas, clientX: 300, clientY: 300 });

    // The source is dropped: the corridor is gone and the release emits nothing.
    expect(rig.overlay.routeCleared.count).toBeGreaterThan(0);
    up(rig, nubAnchor(2, 2, 1));
    expect(rig.sent).toHaveLength(0);
    // The tool stays armed, the resting rings repainted.
    expect(rig.armedCalls.at(-1)).toEqual({ kind: 'wire' });
    expect(rig.cursor()).toBe('crosshair');
    // A right press with no source puts the tool down, exactly as a right-click on the Belt tool does.
    rig.canvas.fire('pointerdown', { button: 2, target: rig.canvas, clientX: 300, clientY: 300 });
    expect(rig.armedCalls.at(-1)).toBeNull();
    expect(rig.cursor()).toBe('');
  });

  it('a_middle_press_with_the_wire_tool_armed_keeps_the_tool', () => {
    // W244 for the wire (D-11): a middle press and release between drags, and one with a source
    // held, keep the Wire tool, and the held source still previews its corridor afterwards.
    rig = setupRigWith({ cellsFromWorld: true }, outNode());
    rig.armWire();
    rig.canvas.fire('pointerdown', { button: 1, target: rig.canvas, clientX: 300, clientY: 300 });
    rig.win.fire('pointerup', { button: 1, target: rig.canvas, clientX: 300, clientY: 300 });
    expect(rig.armedCalls.at(-1), 'a middle press between drags keeps the Wire tool').toEqual({ kind: 'wire' });
    press(rig, nubAnchor(2, 2, 1));
    move(rig, cellPt(5, 2));
    rig.canvas.fire('pointerdown', { button: 1, target: rig.canvas, ...{ clientX: cellPt(5, 2).x, clientY: cellPt(5, 2).y } });
    rig.win.fire('pointerup', { button: 1, target: rig.canvas, ...{ clientX: cellPt(5, 2).x, clientY: cellPt(5, 2).y } });
    expect(rig.armedCalls.at(-1), 'a middle press with a source held keeps the Wire tool').toEqual({ kind: 'wire' });
    const routes = rig.overlay.routeCalls.length;
    move(rig, cellPt(6, 2));
    expect(rig.overlay.routeCalls.length, 'the source survived: a move still previews its corridor').toBeGreaterThan(routes);
    expect(rig.sent, 'a middle release sends no DrawWire').toHaveLength(0);
  });

  it('the_first_escape_with_a_wire_source_cancels_only_the_source', () => {
    // W247 for the wire (D-11): the first Escape drops the held source and keeps the tool; the
    // release after it sends and flashes nothing; the second Escape puts the tool away.
    rig = setupRigWith({ cellsFromWorld: true }, outNode());
    rig.armWire();
    press(rig, nubAnchor(2, 2, 1));
    move(rig, cellPt(5, 2));
    expect(rig.overlay.routeCalls.length, 'NON-VACUITY: the corridor is previewed').toBeGreaterThan(0);
    rig.win.fire('keydown', { key: 'Escape', preventDefault: () => {} });
    expect(rig.armedCalls.at(-1), 'the first Escape keeps the Wire tool').toEqual({ kind: 'wire' });
    const routes = rig.overlay.routeCalls.length;
    move(rig, cellPt(6, 2));
    expect(rig.overlay.routeCalls.length, 'no corridor: the source is gone').toBe(routes);
    up(rig, cellPt(6, 2));
    expect(rig.sent, 'the release after it sends nothing').toHaveLength(0);
    expect(rig.overlay.rejectFlashCalls, 'and flashes nothing').toHaveLength(0);
    rig.win.fire('keydown', { key: 'Escape', preventDefault: () => {} });
    expect(rig.armedCalls.at(-1), 'the second Escape puts the tool away').toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CONNECT-02: the stranded-dock reconnect ring (plan 67-05)
// ---------------------------------------------------------------------------
//
// Six cases, and every one of them exists because the CLAIM it pins is not
// visible in the shape of the code:
//
//   1-2. PRESS PRECEDENCE. "The ring arm is first" is an ORDERING, and an
//        ordering can only be measured where two arms both want the same press.
//        Cases 1 and 2 construct that overlap deliberately (see the comments in
//        each) and are mutation-proved below: moving the ring arm after its
//        competitor reddens exactly the matching case.
//   3.   THE RADIUS IS A RADIUS. A press just OUTSIDE the grab radius must fall
//        through to the ordinary chain. The case also re-presses with the ring
//        moved just INSIDE, so "fell through" cannot mean "no ring was ever
//        reachable" - a boundary case with only the outside half is a check that
//        cannot fail.
//   4-5. THE D-25 RULE, WHICH IS AN ABSENCE. Phase 64's D-25: a decay must never
//        retroactively invalidate a gesture the user is actively completing. The
//        correct implementation is that the drag reads NO clock and NO ring set
//        once it has started, so there is no positive code to point at. These two
//        cases are what stop a later edit adding one. Case 4 used to drive that
//        from the ring's 5000ms TTL; the TTL was retired on 2026-08-30, so it now
//        drives it from the PAINT half of the structural clear (case 5 drives the
//        RECORD half). The rule outlived the clock that first exposed it.
//   6.   A RELEASE ON NOTHING IS NOT SILENT (T-67-05-05, WINDOWS row 113).
//   6.   NEAREST-FIRST + A NAMED TIE-BREAK. One Rotate can strand more than one
//        belt, so the hit test must resolve the nearest rather than the first in
//        array order, and equidistant must be deterministic rather than
//        accidental.
describe('Stranded-dock reconnect ring (CONNECT-02)', () => {
  /** The 3x3 FACTORY fixture: In on the W edge, Out on E, Fault on S. */
  const factory = (): NodeView =>
    node({
      id: 5,
      kind: machine_kind.FACTORY,
      cell_x: 4,
      cell_y: 4,
      w: 3,
      h: 3,
      ports: [
        { index: 0, cell_x: 4, cell_y: 5, side: 3, role: 0, medium: 0 },
        { index: 1, cell_x: 6, cell_y: 5, side: 1, role: 1, medium: 0 },
        { index: 2, cell_x: 5, cell_y: 6, side: 2, role: 2, medium: 0 },
      ],
    });

  const tile = (cx: number, cy: number): TileView => ({
    cell_x: cx,
    cell_y: cy,
    kind: { Straight: { axis: 0 } },
  });

  const belt = (id: number, cells: Array<[number, number]>): BeltView => ({
    id,
    latency: 1,
    fill: 0,
    items: [],
    tiles: cells.map(([x, y]) => tile(x, y)),
    docks: [],
    ticks_per_slot: 1,
  });

  /** Belt A (id 3): tiles (7,5)->(9,5). Its TAIL tile centre is (240,176). */
  const beltA = (): BeltView =>
    belt(3, [
      [7, 5],
      [8, 5],
      [9, 5],
    ]);
  /** Belt B (id 9): tiles (7,8)->(9,8). A SECOND, DIFFERENT belt so a case can
   *  tell WHICH belt the drag named. Its HEAD tile centre is (304,272). */
  const beltB = (): BeltView =>
    belt(9, [
      [7, 8],
      [8, 8],
      [9, 8],
    ]);

  /** Belt A's TAIL handle point - `beltHandlePoints` resolves an undocked end to
   *  its end-tile centre, so this is (7*CELL + CELL/2, 5*CELL + CELL/2). */
  const A_TAIL: Pt = { x: 7 * CELL + CELL / 2, y: 5 * CELL + CELL / 2 };
  /** The Out nub every reconnect below is released onto. */
  const outNub = nubAnchor(6, 5, 1);
  /** The grab radius the ring arm uses, at the rig's identity scale (22 world px). */
  const RING_R = wireNubHitRadiusWorld(1);

  const atPx = (x: number, y: number) => ({ clientX: x, clientY: y });
  const press = (r: Rig, p: Pt): void => {
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...atPx(p.x, p.y) });
  };
  const moveTo = (r: Rig, p: Pt): void => {
    r.win.fire('pointermove', { target: r.canvas, ...atPx(p.x, p.y) });
  };
  const release = (r: Rig, p: Pt): void => {
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...atPx(p.x, p.y) });
  };
  /** Press at `from`, move to `to`, release at `to`. */
  const dragFrom = (r: Rig, from: Pt, to: Pt): void => {
    press(r, from);
    moveTo(r, to);
    release(r, to);
  };
  /** Select a belt: press-then-release on one of its tiles (legacy floor() shim). */
  const selectBelt = (r: Rig, cx: number, cy: number): void => {
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...at(cx, cy) });
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...at(cx, cy) });
  };

  const ringFor = (beltId: number, end: BeltEnd, pt: Pt): StrandedRing => ({
    beltId,
    end,
    pt,
  });

  // -- 1. the ring beats hitHandle at overlapping coordinates ----------------
  it('1. a press where a SELECTED belt handle and a stranded ring overlap starts the RING drag', () => {
    rig = setupRig(factory());
    rig.scene.belts.set(3, beltA());
    rig.scene.belts.set(9, beltB());

    // CONSTRUCTED STATE, NOT A NATURAL ONE. No board produces a stranded ring
    // sitting exactly on another belt's selected endpoint handle: the two are
    // resolved from unrelated geometry. The overlap is manufactured here because
    // an ORDERING can only be measured where both arms want the same press, and
    // a "precedence" test whose two candidates resolve to the same answer is not
    // measuring precedence at all. A later reader should not go looking for the
    // board that produces this.
    selectBelt(rig, 8, 5); // belt A selected -> its TAIL handle is live at A_TAIL
    rig.setStrandedRings([ringFor(9, 'Head', A_TAIL)]);

    dragFrom(rig, A_TAIL, outNub);

    // The RING record won: belt 9 / Head, not belt 3 / Tail (what hitHandle
    // would have produced from the identical press).
    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 9, end: 'Head', node: 5, port: 1 }),
    ]);
  });

  // -- 2. the ring beats the rotate handle ----------------------------------
  it('2. a press where a SELECTED node rotate handle and a stranded ring overlap starts the RING drag, not a rotate', () => {
    rig = setupRig(factory());
    rig.scene.belts.set(3, beltA());

    // CONSTRUCTED STATE, NOT A NATURAL ONE, for the same reason as case 1: a
    // ring sits at a port's or a belt end's own location, never at the rotate
    // handle's corner offset, so this overlap is manufactured to make the
    // ordering measurable.
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(5, 5) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(5, 5) });
    expect(rig.selectedId()).toBe(5); // a NODE is selected -> the rotate arm is live
    rig.overlay.rotateCenter.pt = A_TAIL; // ...and its handle sits ON the ring
    rig.setStrandedRings([ringFor(3, 'Tail', A_TAIL)]);

    dragFrom(rig, A_TAIL, outNub);

    // Exactly one frame and it is the Dock, so `rotatePress` was never set: had
    // it been, the paired up would have emitted a Rotate (disc 2) instead.
    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 3, end: 'Tail', node: 5, port: 1 }),
    ]);
    expect(rig.sent.map((f) => f[0]), 'no Rotate frame (disc 2) was emitted').not.toContain(2);
    // A ring drag really was in flight: the rotate press never draws one.
    expect(rig.overlay.draggedHandleCalls.length).toBeGreaterThan(0);
  });

  // -- 3. outside the radius, the ordinary chain is unchanged ----------------
  it('3. a press OUTSIDE the ring radius falls through to the ordinary chain; just INSIDE it does not', () => {
    rig = setupRig(factory());
    rig.scene.belts.set(3, beltA());
    const bodyCell = at(5, 5); // inside the factory footprint
    const bodyPt: Pt = { x: bodyCell.clientX, y: bodyCell.clientY };

    // Ring one pixel OUTSIDE the grab radius of the press point.
    rig.setStrandedRings([ringFor(3, 'Tail', { x: bodyPt.x + RING_R + 1, y: bodyPt.y })]);
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...bodyCell });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...bodyCell });

    // Ordinary node select, exactly as before this feature existed.
    expect(rig.overlay.selections).toEqual([5]);
    expect(rig.sent).toHaveLength(0);
    expect(rig.overlay.draggedHandleCalls).toHaveLength(0);

    // THE OTHER HALF, without which "it fell through" could just mean "no ring
    // was reachable from anywhere". Move the SAME ring one pixel INSIDE and the
    // identical press starts the drag.
    rig.setStrandedRings([ringFor(3, 'Tail', { x: bodyPt.x + RING_R - 1, y: bodyPt.y })]);
    dragFrom(rig, bodyPt, outNub);
    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 3, end: 'Tail', node: 5, port: 1 }),
    ]);
  });

  // -- 4. the ring's PAINT going away never cancels the drag (D-25) ----------
  //
  // REWRITTEN 2026-08-30, in the same commit as the TTL retirement. This case
  // used to read "a ring drag that outlives ALERT_TTL_MS still lands its Dock",
  // and its premise - a clock that retires a ring mid-drag - no longer exists:
  // the ring now persists until the strand is RESOLVED. The case is rewritten
  // rather than deleted because D-25 is not about the TTL. The rule is that a
  // gesture in flight must never be invalidated by anything that happens to the
  // affordance it started from, and there is still a path that retires a ring
  // mid-drag: `overlay.clearAlertRings()`, fired by App on a structural edit.
  //
  // WHAT MAKES IT A DIFFERENT CASE FROM 5. This one flips the PAINT half alone -
  // `alertRingsActive()` goes false while the gesture layer's own record set is
  // untouched. Case 5 retracts BOTH. App drives them together, but the halves
  // live in two modules and only one of them is re-read by anything: a `press`
  // that reads the gate would break 4, a `move`/`release` that re-consulted
  // `strandedRings` would break 5.
  it('4. a ring drag whose alert PAINT is cleared mid-drag still lands its Dock', () => {
    rig = setupRig(factory());
    rig.scene.belts.set(3, beltA());
    rig.setStrandedRings([ringFor(3, 'Tail', A_TAIL)]);

    press(rig, A_TAIL);
    moveTo(rig, { x: A_TAIL.x + 20, y: A_TAIL.y });

    // THE PAINT IS RETIRED, MID-DRAG. This is exactly what `clearAlertRings`
    // does: it nulls `alertBornMs`, so `alertRingsActive()` goes false and the
    // rings stop being painted. Nothing touches the gesture layer's own record
    // set, which is why the flag alone is what is flipped here. Simulated by the
    // flag rather than by driving `overlay.tick` because the gesture layer must
    // not know the ring's timing at all (`grep -c ALERT_SETTLE_MS gestures.ts`
    // is 0 - now genuinely asserted, at the end of this describe; before
    // 2026-08-30 this comment claimed an assertion that did not exist).
    rig.overlay.alertRings.active = false;

    moveTo(rig, outNub);
    release(rig, outNub);

    expect(rig.sent, 'the retired ring did not cancel the gesture in flight').toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 3, end: 'Tail', node: 5, port: 1 }),
    ]);
  });

  // -- 5. an unrelated structural edit never cancels the drag either ---------
  it('5. a ring drag survives an unrelated structural edit clearing the ring set', () => {
    rig = setupRig(factory());
    rig.scene.belts.set(3, beltA());
    rig.setStrandedRings([ringFor(3, 'Tail', A_TAIL)]);

    press(rig, A_TAIL);
    moveTo(rig, { x: A_TAIL.x + 20, y: A_TAIL.y });

    // A structural edit somewhere ELSE on the board arrives. App's packet
    // handler retracts the ring set in the same place it clears the paint - the
    // exact call it makes, made here.
    rig.setStrandedRings([]);
    rig.overlay.alertRings.active = false;

    moveTo(rig, outNub);
    release(rig, outNub);

    expect(rig.sent, 'the retracted ring set did not cancel the gesture in flight').toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 3, end: 'Tail', node: 5, port: 1 }),
    ]);
  });

  // -- 6. a release over NOTHING says something (T-67-05-05) -----------------
  //
  // 67-UI-SPEC 4.2's "Release, on nothing" row: *"Emit nothing (D-07/D-08: no
  // port to name). `showRejectFlash` over the released cell, WHERE only."* Plan
  // 67-05 reused `handleDrag`'s release arm byte-unchanged and assumed the flash
  // was already in it; it never was. All five shipped `showRejectFlash` sites
  // were on the Place and DrawWire paths, so the ONE gesture this phase added -
  // the recovery gesture - was the one gesture that answered a near-miss with
  // nothing at all. That is the silent-gesture shape WINDOWS row 113 tracks.
  //
  // BOTH HALVES ARE HERE ON PURPOSE. A case asserting only "the flash fired"
  // passes against an implementation that flashes on EVERY release, including
  // the successful ones - which would put a fault-red decay over a dock that
  // just worked. The accepting half is what refuses that.
  it('6. a ring drag released over empty canvas flashes WHERE it landed and emits nothing', () => {
    rig = setupRig(factory());
    rig.scene.belts.set(3, beltA());
    rig.setStrandedRings([ringFor(3, 'Tail', A_TAIL)]);

    // Far from every nub (the factory's are around x=192) and every belt tile.
    // The rig's default `screenToCell` is the documented floor() shim, so this
    // point is cell (900, 700) - the cell the pointer was actually released on,
    // which is the only honest WHERE available when no port was named.
    const EMPTY: Pt = { x: 900.5, y: 700.5 };
    dragFrom(rig, A_TAIL, EMPTY);

    expect(rig.sent, 'no port was aimed at, so no command is forged').toHaveLength(0);
    expect(rig.overlay.rejectFlashCalls).toEqual([
      { cell: { cx: 900, cy: 700 }, dims: { w: 1, h: 1, rot: 0 } },
    ]);

    // THE OTHER HALF: an ACCEPTING release emits and stays silent on the canvas.
    // The host owns the words from here (D-07); a flash over a dock that landed
    // would be the canvas contradicting it.
    rig.destroy();
    rig = setupRig(factory());
    rig.scene.belts.set(3, beltA());
    rig.setStrandedRings([ringFor(3, 'Tail', A_TAIL)]);

    dragFrom(rig, A_TAIL, outNub);

    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 3, end: 'Tail', node: 5, port: 1 }),
    ]);
    expect(rig.overlay.rejectFlashCalls, 'a landed dock is never flashed').toHaveLength(0);
  });

  // -- the OTHER caller of the same arm, and it means the opposite ------------
  it('6b. a SELECTED-BELT handle drag released on nothing does NOT flash: that release is the documented CANCEL', () => {
    // THE REGRESSION THIS PINS, measured by phase 67's delta re-verification.
    // An earlier commit put the reject flash in the SHARED `handleDrag` release
    // arm on the reasoning that "the near-miss is identical in both" callers.
    // It is not. The two callers disagree about what a release on nothing MEANS:
    //
    //   - from a stranded RING it is a near-miss on a recovery attempt (case 6);
    //   - from a selected belt's endpoint HANDLE it is the DOCUMENTED CANCEL -
    //     `21-UI-SPEC.md:137` and `:206`, "No command; handle snaps back" - and
    //     it is that gesture's ONLY abort, because Escape (`gestures.ts:2686`)
    //     does not touch `handleDrag`.
    //
    // So the widened version flashed a rejection at a user who had deliberately
    // backed out. The whole 2012-case suite stayed green through it; it was
    // caught by a probe on `rejectFlashCalls`. This case is that probe, kept.
    rig = setupRig(factory());
    rig.scene.belts.set(3, beltA());

    // NO stranded ring is set. The drag can only come from `hitHandle`, which is
    // selection-gated - so selecting the belt is the precondition, not decoration.
    selectBelt(rig, 8, 5); // belt A selected -> its TAIL handle is live at A_TAIL

    // The identical release point case 6 uses, so the two cases differ in
    // PROVENANCE and nothing else. If this ever flashes, the arm has re-widened.
    const EMPTY: Pt = { x: 900.5, y: 700.5 };
    dragFrom(rig, A_TAIL, EMPTY);

    expect(rig.sent, 'a cancel emits nothing, exactly as a near-miss does').toHaveLength(0);
    expect(
      rig.overlay.rejectFlashCalls,
      'the handle snaps back in silence: this release is a cancel, not a refusal',
    ).toHaveLength(0);
  });

  // -- the grabbable hover cue (67-UI-SPEC 4.2 Hover row) --------------------
  it('hovering a stranded ring shows the r=8 hover ring + cursor pointer; leaving clears both', () => {
    rig = setupRig(factory());
    rig.scene.belts.set(3, beltA());
    rig.setStrandedRings([ringFor(3, 'Tail', A_TAIL)]);

    // Inside the grab radius, no drag in flight -> the cue appears at the RING's
    // own point (not the pointer's), reusing showHandleRing's existing child.
    moveTo(rig, { x: A_TAIL.x + 5, y: A_TAIL.y });
    expect(rig.overlay.handleRingCalls).toEqual([A_TAIL]);
    expect(rig.cursor()).toBe('pointer');

    // Leaving the radius clears the ring and restores the cursor.
    moveTo(rig, { x: A_TAIL.x + RING_R + 40, y: A_TAIL.y });
    expect(rig.overlay.handleRingCleared.count).toBeGreaterThan(0);
    expect(rig.cursor()).toBe('');
  });

  // -- 67-REVIEW WR-01: the cue survives arriving from a belt endpoint handle --
  it('a move that arrives from a SELECTED belt handle hover still paints the stranded ring cue', () => {
    rig = setupRig(factory());
    rig.scene.belts.set(3, beltA());
    rig.scene.belts.set(9, beltB());

    // THE PRECONDITION THE ORIGINAL CASE NEVER SET, AND THE WHOLE POINT OF THIS
    // ONE. `clearHandleHover` clears the `handleRing` Graphics child and resets a
    // 'pointer' cursor - and the stranded cue REUSES that same child. It is a
    // no-op unless `handleHover` is true, which needs a SELECTED BELT whose
    // endpoint handle the cursor has just been over. The existing hover case
    // never selects a belt, so it can never see the branch clear what it just
    // painted. Here belt B is selected and its TAIL handle is hovered first.
    selectBelt(rig, 8, 8); // belt B (tiles (7,8)->(9,8)) -> its handles go live
    const B_TAIL: Pt = { x: 7 * CELL + CELL / 2, y: 8 * CELL + CELL / 2 };
    moveTo(rig, B_TAIL);
    expect(rig.overlay.handleRingCalls.at(-1), 'the belt-handle hover is live').toEqual(B_TAIL);
    expect(rig.cursor()).toBe('pointer');

    // Now move onto a stranded ring somewhere else. The stranded branch must end
    // the handler with ITS ring painted and the pointer cursor set.
    rig.setStrandedRings([ringFor(3, 'Tail', A_TAIL)]);
    moveTo(rig, { x: A_TAIL.x + 5, y: A_TAIL.y });

    expect(
      rig.overlay.handleRingCalls.at(-1),
      'the LAST paint is the stranded ring, not the belt handle it replaced',
    ).toEqual(A_TAIL);
    expect(
      rig.overlay.handleRingCleared.count,
      'and the clear happened BEFORE that paint, not after it - the paint is the ' +
        'last thing this handler did',
    ).toBeGreaterThan(0);
    expect(rig.cursor(), 'the grab cue promises a grab, so the cursor has to agree').toBe(
      'pointer',
    );
  });

  // -- 67-REVIEW WR-02: pressing a ring drops a NODE selection properly -------
  it('pressing a ring while a NODE is selected clears that selection on the canvas AND in App', () => {
    rig = setupRig(factory());
    rig.scene.belts.set(3, beltA());

    // THE PRECONDITION, AND IT IS THE ORDINARY STATE, NOT A CONTRIVED ONE: the
    // severing Rotate is performed on a SELECTED node, so the ring the user
    // presses next is almost always pressed with that node still selected.
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(5, 5) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(5, 5) });
    expect(rig.selectedId()).toBe(5);
    const clearedBefore = rig.overlay.selectionCleared.count;
    rig.onSelectCalls.length = 0;

    rig.setStrandedRings([ringFor(3, 'Tail', A_TAIL)]);
    press(rig, A_TAIL);

    // The gesture layer now owns a BELT selection, so both other selection
    // models have to be told the node is gone. Without these two calls the
    // canvas kept painting the node outline and App kept its ConfigPanel open
    // on a node the gesture layer no longer considers selected.
    expect(
      rig.overlay.selectionCleared.count,
      'the canvas outline is cleared: overlay.clearSelection() fired',
    ).toBeGreaterThan(clearedBefore);
    expect(rig.onSelectCalls, 'App is told the node selection is gone').toEqual([null]);
    expect(rig.selectedId(), 'and the chrome-facing handle reads null').toBeNull();

    release(rig, A_TAIL);
  });

  it('the hover cue is suppressed while a ring drag is in flight, even over a SECOND live ring', () => {
    rig = setupRig(factory());
    rig.scene.belts.set(3, beltA());
    rig.scene.belts.set(9, beltB());
    // TWO rings, and the drag is started on the FIRST. The second stays live and
    // painted (only the pressed one is retired), so dragging across it is the
    // only state where this claim is testable at all - with ONE ring the
    // press-side retire has already emptied the hit set and every build agrees.
    //
    // WHAT THIS ACTUALLY MEASURES, stated because the first draft measured
    // nothing: there is no `!handleDrag` guard on the hover branch and there
    // must not be one (it would be dead code - see the comment at the branch).
    // The cue stays off the screen because the hover section sits BELOW
    // onWinMove's `if (handleDrag) { ...; return; }`. This case is therefore an
    // assertion about WHERE the branch was inserted, and it reddens if the
    // branch is hoisted above that return.
    const other: Pt = { x: 240, y: 400 };
    rig.setStrandedRings([ringFor(3, 'Tail', A_TAIL), ringFor(9, 'Head', other)]);

    press(rig, A_TAIL);
    const before = rig.overlay.handleRingCalls.length;
    // Drag ACROSS the second ring. The drag owns the cursor and the overlay:
    // painting a "grab me" cue for a different affordance mid-gesture would
    // promise something the release cannot deliver.
    moveTo(rig, { x: other.x + 2, y: other.y });
    expect(rig.overlay.handleRingCalls.length, 'no hover cue was painted mid-drag').toBe(before);
    expect(rig.cursor()).toBe('grabbing');
    release(rig, other);
  });

  it('pressing a ring retires THAT ring only; a second stranded ring stays painted', () => {
    rig = setupRig(factory());
    rig.scene.belts.set(3, beltA());
    rig.scene.belts.set(9, beltB());
    const other: Pt = { x: 240, y: 400 }; // far away, untouched by the press
    rig.setStrandedRings([ringFor(3, 'Tail', A_TAIL), ringFor(9, 'Head', other)]);

    press(rig, A_TAIL);

    // EXACTLY the pressed point was retired - the overlay keeps the rest.
    expect(rig.overlay.alertRingAtCleared).toEqual([A_TAIL]);

    // ...and the OTHER ring is still pressable. Release this drag first, then
    // press the survivor: it starts its own drag naming belt 9 / Head.
    release(rig, A_TAIL);
    rig.sent.length = 0;
    dragFrom(rig, other, outNub);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 9, end: 'Head', node: 5, port: 1 }),
    ]);
  });

  // -- 67-REVIEW WR-03: a retire MISS drops the stale record and falls through --
  it('a press whose ring the overlay does not hold drops the record and starts NO drag', () => {
    rig = setupRig(factory());
    rig.scene.belts.set(3, beltA());
    rig.setStrandedRings([ringFor(3, 'Tail', A_TAIL)]);

    // THE DRIFT, MADE EXPLICIT. `clearAlertRingAt` matches on EXACT coordinate
    // equality, and nothing enforces that the gesture layer's ring records and
    // App's painted points carry the same values - today they agree only because
    // App hands the same object literal to both channels. The stub answers "no
    // ring here", which is what the real overlay answers on any such drift.
    rig.overlay.alertRings.miss = true;

    dragFrom(rig, A_TAIL, outNub);

    // NO Dock was emitted: a drag must never start from an affordance that is not
    // on screen. The old code ignored the answer and started one anyway.
    expect(rig.sent, 'no drag started, so no Dock frame').toHaveLength(0);
    // The stale record is GONE, which converges the pressable set back into the
    // painted one - the only safe direction. A second press over the same point
    // is now an ordinary press with nothing to hit.
    rig.overlay.alertRings.miss = false;
    rig.overlay.alertRingAtCleared.length = 0;
    press(rig, A_TAIL);
    expect(
      rig.overlay.alertRingAtCleared,
      'the record really was dropped - the second press finds no ring to retire',
    ).toEqual([]);
    release(rig, A_TAIL);
  });

  // -- 6. nearest-first, with a named tie-break ------------------------------
  it('6. two rings in radius resolve NEAREST-first; an exact tie resolves to the EARLIER record', () => {
    rig = setupRig(factory());
    rig.scene.belts.set(3, beltA());
    rig.scene.belts.set(9, beltB());

    const near: Pt = { x: 240, y: 176 }; // ring X -> belt 3 / Tail
    const far: Pt = { x: 270, y: 176 }; // ring Y -> belt 9 / Head

    // ORDER IS DELIBERATELY THE WRONG WAY ROUND: the FARTHER ring is FIRST in
    // the array. A first-match implementation would answer belt 9 here.
    const rings = [ringFor(9, 'Head', far), ringFor(3, 'Tail', near)];
    rig.setStrandedRings(rings);

    // (a) NEAREST WINS. 12px from X, 18px from Y - both inside the 22px radius,
    // so this is a genuine two-candidate press and not a one-candidate one.
    const between: Pt = { x: 252, y: 176 };
    expect(Math.hypot(between.x - near.x, between.y - near.y)).toBeLessThan(RING_R);
    expect(Math.hypot(between.x - far.x, between.y - far.y)).toBeLessThan(RING_R);
    dragFrom(rig, between, outNub);
    expect([...rig.sent[0]], 'the NEARER ring won, despite being second in the array').toEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 3, end: 'Tail', node: 5, port: 1 }),
    ]);

    // (b) THE TIE-BREAK, NAMED. Exactly equidistant from both. The hit test
    // scans in array order with a STRICT `<` comparison, so ties keep
    // enumeration order and the EARLIER record wins - the same stable rule
    // `nubsInRadius` (sorted nearest-first, stable) and `hitHandle`
    // (`dh <= dt` -> Head) already use. Here the earlier record is ring Y, so a
    // tie must answer belt 9 / Head even though belt 3 won part (a).
    rig.setStrandedRings(rings);
    const midpoint: Pt = { x: (near.x + far.x) / 2, y: 176 };
    expect(midpoint.x - near.x).toBe(far.x - midpoint.x); // an EXACT tie, not a near-tie
    dragFrom(rig, midpoint, outNub);
    expect(
      [...rig.sent[1]],
      'an exact tie resolves to the EARLIER record in array order (ring Y, belt 9)',
    ).toEqual([...encodeGridCommand({ kind: 'Dock', belt: 9, end: 'Head', node: 5, port: 1 })]);
  });

  // -- the ring's timing constant NEVER escapes overlay.ts -------------------
  //
  // ADDED 2026-08-30. Case 4's comment has claimed since 67-05 that
  // `grep -c ALERT_SETTLE_MS gestures.ts` is 0 "and that is an assertion". It
  // was not one - there was no source check anywhere in this file. Discovered
  // while rewriting case 4 for the TTL retirement, and made true rather than
  // un-claimed, because the claim is the right one: one ring lifetime, one
  // owner. `hitStrandedRing` reads `overlay.alertRingsActive()` - the same
  // `alertBornMs` state the paint is driven from - precisely so this layer never
  // needs a number of its own. A copy here would be the second-source-of-truth
  // failure Phase 65 found in `ROUTER_PRESET_PORT_LEGS`.
  // Phase 88 review IN-06: the playing-tick fallback every client record of a gesture uses
  // (a pending Place, a held belt, a sent Dock, a queued claim) is ONE figure. It was two
  // literals, `ECHO_TTL_TICKS = 120` here and `CLAIM_TTL_TICKS = 120` in queuedClaims.ts, so
  // one could move without the other and a claim would outlive, or die before, the pending
  // entry it shadows. The literal lives in queuedClaims.ts and this layer derives from it.
  it('the gesture fallback has ONE owner: gestures.ts derives ECHO_TTL_TICKS from CLAIM_TTL_TICKS', () => {
    const src = readFileSync(join(import.meta.dirname, 'gestures.ts'), 'utf8');
    expect(src, 'no literal of its own').not.toMatch(/ECHO_TTL_TICKS\s*=\s*\d/);
    expect(src, 'and the read it uses instead is present').toMatch(/ECHO_TTL_TICKS\s*=\s*CLAIM_TTL_TICKS\b/);
  });

  it('gestures.ts names no alert-ring timing constant: the lifetime has ONE owner', () => {
    const src = readFileSync(join(import.meta.dirname, 'gestures.ts'), 'utf8');
    // Both the current name and the retired one: a revert that reintroduced the
    // old constant here would be as wrong as a copy of the new one.
    expect(src).not.toContain('ALERT_SETTLE_MS');
    expect(src).not.toContain('ALERT_TTL_MS');
    // ...and the read it uses INSTEAD is present, so "no constant" cannot be
    // satisfied by a layer that consults nothing at all.
    expect(src).toContain('overlay.alertRingsActive()');
  });
});

// ===========================================================================
// D-04: the one-drag cable, PREVIEWED. Plan 72-11, rulings R-70 to R-73.
// ===========================================================================
//
// Plan 72-08 made ONE `DrawWire` between a Route and a Handler mint BOTH cable legs
// under one action id. `cableLane.ts`'s own header states the rule this inherits: the
// ghost's lane key and the landed cable's lane key are computed from ONE expression
// precisely because otherwise "the preview would promise a corridor the landed cable
// does not take, which is the failure that disqualified the `fabrico-command` corridor
// offset". A drag that previews ONE cable and lands TWO is that same failure, one grain
// coarser, so the drag has to show both.
//
// THE BOARD BELOW IS UI-SPEC 5.3's WORKED EXAMPLE, cell for cell: a 1x1 Route at
// (10,6) and a 3x3 Handler at (14,6), with the port geometry taken from
// `MACHINE_CATALOG[ENDPOINT]` and `MACHINE_CATALOG[HANDLER]` rather than invented here.
describe('the paired cable preview (D-04, plan 72-11)', () => {
  const ELEC = MEDIUM_ELECTRICAL;
  const MECH = MEDIUM_MECHANICAL;

  /**
   * A Route (kind 9), 1x1, ports exactly as `MACHINE_CATALOG[machine_kind.ENDPOINT]`
   * declares them: index 0 the electrical In facing W, index 1 the electrical Out
   * facing E, BOTH on the node's single cell.
   */
  const routeNode = (id: number, cx: number, cy: number): NodeView =>
    node({
      id,
      kind: machine_kind.ENDPOINT,
      cell_x: cx,
      cell_y: cy,
      ports: [
        { index: 0, cell_x: cx, cell_y: cy, side: 3, role: 0, medium: ELEC },
        { index: 1, cell_x: cx, cell_y: cy, side: 1, role: 1, medium: ELEC },
      ],
    });

  /**
   * A Handler (kind 10), 3x3, ports exactly as `MACHINE_CATALOG[machine_kind.HANDLER]`
   * declares them: index 0 the electrical In at local (0,1) facing W, index 1 the ONE
   * electrical Out at local (2,1) facing E, index 2 the MECHANICAL Fault at local (1,2)
   * facing S. The single Out is D-02 and it is what refuses a second Route.
   */
  const handlerNode = (id: number, cx: number, cy: number): NodeView =>
    node({
      id,
      kind: machine_kind.HANDLER,
      cell_x: cx,
      cell_y: cy,
      w: 3,
      h: 3,
      ports: [
        { index: 0, cell_x: cx, cell_y: cy + 1, side: 3, role: 0, medium: ELEC },
        { index: 1, cell_x: cx + 2, cell_y: cy + 1, side: 1, role: 1, medium: ELEC },
        { index: 2, cell_x: cx + 1, cell_y: cy + 2, side: 2, role: 2, medium: MECH },
      ],
    });

  /** A 1x1 Router: one electrical Out facing E and one electrical In facing W. */
  const routerNode = (id: number, cx: number, cy: number): NodeView =>
    node({
      id,
      kind: machine_kind.ROUTER,
      cell_x: cx,
      cell_y: cy,
      ports: [
        { index: 0, cell_x: cx, cell_y: cy, side: 3, role: 0, medium: ELEC },
        { index: 1, cell_x: cx, cell_y: cy, side: 1, role: 1, medium: ELEC },
      ],
    });

  const at = (n: NodeView, portIndex: number): Pt =>
    nubAnchor(n.ports[portIndex].cell_x, n.ports[portIndex].cell_y, n.ports[portIndex].side);
  const press = (r: Rig, pt: Pt): void => {
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, clientX: pt.x, clientY: pt.y });
  };
  const move = (r: Rig, pt: Pt): void => {
    r.win.fire('pointermove', { target: r.canvas, clientX: pt.x, clientY: pt.y });
  };
  const lastRoute = (r: Rig): (typeof r.overlay.routeCalls)[number] =>
    r.overlay.routeCalls[r.overlay.routeCalls.length - 1];
  /** Nudge 6 world px off a nub anchor: inside `wireNubHitRadiusWorld(1)` (22). */
  const near = (pt: Pt, dx: number): Pt => ({ x: pt.x + dx, y: pt.y });
  const key = (c: { cx: number; cy: number }): string => `${c.cx},${c.cy}`;

  let rig: Rig | undefined;
  afterEach(() => {
    rig?.destroy();
    rig = undefined;
  });

  /** Drive the UI-SPEC 5.3 drag: press the Route's Out, hold over the Handler's In. */
  const dragRouteToHandler = (
    extra: (r: Rig, route: NodeView, handler: NodeView) => void = () => {},
  ): { rig: Rig; route: NodeView; handler: NodeView } => {
    const route = routeNode(1, 10, 6);
    const handler = handlerNode(2, 14, 6);
    const r = setupRigWith({ cellsFromWorld: true }, route, handler);
    extra(r, route, handler);
    r.armWire();
    press(r, at(route, 1));
    move(r, near(at(handler, 0), 6));
    return { rig: r, route, handler };
  };

  it('R-70: a legal Route-to-Handler drag previews BOTH corridors, not one', () => {
    // THE WHOLE POINT. One drag lands two cables (72-08), so one drag must preview two
    // corridors. RED before this plan because the drag branch called showRoute with the
    // forward leg alone.
    const d = dragRouteToHandler();
    rig = d.rig;
    const call = lastRoute(rig);
    expect(call.valid, 'the Handler In is a legal target').toBe(true);
    expect(call.pairedLegs, 'the drag previews the OTHER leg too').toHaveLength(1);

    // The forward corridor. RE-BLESSED 2026-09-03 by plan 72-15, deliberately: the
    // fifth cell was `{ cx: 14, cy: 6 }` and is now `{ cx: 13, cy: 7 }`.
    //
    // WHY IT MOVED, because a re-blessed expectation with no reason is indistinguishable
    // from a silent regression. `(14,6)` is the Handler's TOP-LEFT BODY CELL: the old
    // X-first router ran to the target's column and then dropped INTO the machine,
    // clipping its roof before reaching the In. The face-aligned router turns down one
    // column EARLIER, in free column 13, and takes its last step EAST into `(14,7)` so
    // the cable arrives through the face the In nub is actually drawn on. Measured on
    // this fixture: the forward leg now touches ZERO Handler body cells, where it
    // previously touched one.
    expect(call.path).toEqual([
      { cx: 10, cy: 6 },
      { cx: 11, cy: 6 },
      { cx: 12, cy: 6 },
      { cx: 13, cy: 6 },
      { cx: 13, cy: 7 },
      { cx: 14, cy: 7 },
    ]);
    expect(call.lane, 'first x 10 < last 14, so the +1 lane').toBe(1);

    // THE RETURN CORRIDOR GOES AROUND. RE-BLESSED 2026-09-04 by plan 72-16, and this
    // is the whole point of that plan rather than a side effect, so the reason is
    // written here in full.
    //
    // It used to be 8 cells: out of the Handler's East Out and then X-first back
    // along row 7, THROUGH the Handler's own body, arriving at the west-facing Route
    // In from the east side of the machine it had just crossed. The maintainers ruled on that
    // cable on 2026-09-04 with the words "make it go around": it was drawn detached
    // from BOTH of its ports, 16.6 px at the Handler Out and 14.5 px at the Route In,
    // because its terminal segments ran on neither port's normal axis.
    //
    // Every one of this pair's four admissibility booleans is false (the Out faces E,
    // the target is WEST of it, and the In's inward normal also points E), so the
    // perimeter-ring candidate fires. The shape below is: one cell east out of the
    // Out's own face, north up the OUTSIDE of the Handler's east wall, west along row
    // 5 which is clear of both machines, then east into the Route's west socket. The
    // first step is +x (the Out's outward normal) and the last step is +x (against
    // the In's outward normal), which is what lets `wires.ts::clampEndToNub` apply at
    // BOTH ends instead of declining at one.
    expect(call.pairedLegs[0].path).toEqual([
      { cx: 16, cy: 7 },
      { cx: 17, cy: 7 },
      { cx: 17, cy: 6 },
      { cx: 17, cy: 5 },
      { cx: 16, cy: 5 },
      { cx: 15, cy: 5 },
      { cx: 14, cy: 5 },
      { cx: 13, cy: 5 },
      { cx: 12, cy: 5 },
      { cx: 11, cy: 5 },
      { cx: 10, cy: 5 },
      { cx: 9, cy: 5 },
      { cx: 9, cy: 6 },
      { cx: 10, cy: 6 },
    ]);
    // 14 cells against 8. That is the cost, and it is exactly the 14 J-7 costed.
    expect(call.pairedLegs[0].path).toHaveLength(14);
    expect(call.pairedLegs[0].lane, 'first x 16 > last 10, so the -1 lane').toBe(-1);
  });

  it('R-70: the return ghost is the SAME wireRouteAvoiding and cableLane calls the landed cable makes', () => {
    // NOT a mirrored expectation. The two values below are produced by invoking the
    // shipped `wireRoute` and the shipped `cableLane` - the exact functions
    // `layers/wires.ts` strokes the landed cable through - on the two docks the
    // command layer resolves (`command.rs` route_handler_pair + first_electrical_port).
    // If the ghost ever stopped agreeing with them, the preview would be promising a
    // corridor the cable does not take, which is the failure `cableLane.ts` was
    // written after.
    const d = dragRouteToHandler();
    rig = d.rig;
    const call = lastRoute(rig);

    const handlerOut = d.handler.ports[1];
    const routeIn = d.route.ports[0];
    // THE BODY IS PART OF THE EXPECTATION NOW, and deliberately derived the same way
    // production derives it: `pairPreview` passes `bodyOfNode(...)` of these two exact
    // `NodeView`s. If the test's body and the production body ever disagree, this
    // reddens — which is the gate, not an inconvenience.
    // Plan 92-03 (D-09): the landed cable is routed around the board's machines, so the
    // expectation is too, with the scene's two machines as the list the host builds.
    const expected = wireRouteAvoiding(
      {
        cell: [handlerOut.cell_x, handlerOut.cell_y],
        side: handlerOut.side,
        body: bodyOfNode(d.handler),
      },
      { cell: [routeIn.cell_x, routeIn.cell_y], side: routeIn.side, body: bodyOfNode(d.route) },
      [bodyOfNode(d.route), bodyOfNode(d.handler)],
    );
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    expect(call.pairedLegs[0].path).toEqual(
      expected.geometry.tiles.map((t) => ({ cx: t.cell_x, cy: t.cell_y })),
    );
    expect(call.pairedLegs[0].lane).toBe(cableLane(expected.geometry.tiles));
  });

  it('R-70 with a third machine: the return ghost reads the machine list the host builds (review IN-C-04)', () => {
    // The equality above passes only the two endpoint bodies, and with that list
    // `wireRouteAvoiding` answers the plain ladder, so it cannot tell whether the gesture and the
    // host pass the SAME list. Here a Sink stands on the return leg's corridor (row 5, which the
    // R-70 detour above runs along), and the expectation's list is built the way the host builds
    // it (`render_packet.rs` `wire_obstacles`): every scene node whose kind is a wire obstacle,
    // through `bodyOfNode`.
    const sink = node({
      id: 4,
      kind: machine_kind.SINK,
      cell_x: 13,
      cell_y: 5,
      ports: [{ index: 0, cell_x: 13, cell_y: 5, side: 3, role: 0, medium: MECH }],
    });
    // The R-70 board (`dragRouteToHandler`'s Route at (10,6) and Handler at (14,6)) plus the Sink.
    const route = routeNode(1, 10, 6);
    const handler = handlerNode(2, 14, 6);
    rig = setupRigWith({ cellsFromWorld: true }, route, handler, sink);
    rig.armWire();
    press(rig, at(route, 1));
    move(rig, near(at(handler, 0), 6));
    const call = lastRoute(rig);
    expect(call.pairedLegs, 'PRECONDITION: the drag previews the return leg').toHaveLength(1);
    const handlerOut = handler.ports[1];
    const routeIn = route.ports[0];
    const from = { cell: [handlerOut.cell_x, handlerOut.cell_y] as [number, number], side: handlerOut.side, body: bodyOfNode(handler) };
    const to = { cell: [routeIn.cell_x, routeIn.cell_y] as [number, number], side: routeIn.side, body: bodyOfNode(route) };
    const hostList = [route, handler, sink].filter((n) => isWireObstacle(n.kind)).map(bodyOfNode);
    expect(hostList, 'the host list holds all three machines').toHaveLength(3);
    const expected = wireRouteAvoiding(from, to, hostList);
    const endpointsOnly = wireRouteAvoiding(from, to, [bodyOfNode(route), bodyOfNode(handler)]);
    expect(expected.ok && endpointsOnly.ok).toBe(true);
    if (!expected.ok || !endpointsOnly.ok) return;
    const cells = (t: { cell_x: number; cell_y: number }[]) => t.map((c) => ({ cx: c.cell_x, cy: c.cell_y }));
    expect(
      cells(expected.geometry.tiles),
      'NON-VACUITY: the Sink is in the way, so the host list and the endpoint-only list route differently',
    ).not.toEqual(cells(endpointsOnly.geometry.tiles));
    expect(call.pairedLegs[0].path, 'the return ghost is the route the host draws around all three machines').toEqual(cells(expected.geometry.tiles));
    expect(call.pairedLegs[0].lane).toBe(cableLane(expected.geometry.tiles));
  });

  it('CHROME-19: the ghost leg goes around a third machine', () => {
    // Phase 92, D-09, UI-SPEC 4.1 rule 5: the drag preview shows the path the cable lands
    // on, and the landed cable goes around a third machine. The board is the one
    // `crates/fabrico-host/tests/cable_obstacles.rs` and `92-cable-around-machine` build: a
    // Route at (8,8), a 3x3 Factory anchored at (12,7) (box 12..14 x 7..9) and a Handler at
    // (18,7) whose In sits at (18,8). The ladder alone runs row 8 straight through the
    // Factory's middle row. RED AT `PHASE92_START`: `ghostLeg` called the two-argument
    // `wireRoute`, which knows only the two endpoint bodies.
    const route = routeNode(1, 8, 8);
    const factory = node({
      id: 3,
      kind: machine_kind.FACTORY,
      cell_x: 12,
      cell_y: 7,
      w: 3,
      h: 3,
      ports: [
        { index: 0, cell_x: 12, cell_y: 8, side: 3, role: 0, medium: MECH },
        { index: 1, cell_x: 14, cell_y: 8, side: 1, role: 1, medium: MECH },
        { index: 2, cell_x: 13, cell_y: 9, side: 2, role: 2, medium: MECH },
      ],
    });
    const handler = handlerNode(2, 18, 7);
    rig = setupRigWith({ cellsFromWorld: true }, route, factory, handler);
    rig.armWire();
    press(rig, at(route, 1));
    move(rig, near(at(handler, 0), 6));
    const call = lastRoute(rig);
    expect(call.valid, 'PRECONDITION: the Handler In is a legal target').toBe(true);
    expect(call.pairedLegs, 'PRECONDITION: the drag previews the return leg too').toHaveLength(1);
    const inFactory = (c: { cx: number; cy: number }): boolean =>
      c.cx >= 12 && c.cx <= 14 && c.cy >= 7 && c.cy <= 9;
    const legs = [call.path, ...call.pairedLegs.map((l) => l.path)];
    expect(
      legs.map((path) => path.filter(inFactory).map(key)),
      `RED-FIRST CHROME-19-gesture: no ghost leg enters the Factory's box (12..14, 7..9); forward ${JSON.stringify(call.path.map(key))}`,
    ).toEqual([[], []]);
    // The forward leg still runs nub to nub: it leaves the Route's Out cell and arrives on
    // the Handler's In cell.
    expect([key(call.path[0]), key(call.path[call.path.length - 1])]).toEqual(['8,8', '18,8']);
  });

  // Review fix pass 1, WR-A-04 (threat T-92-11): on a paused board a gesture waits in the host
  // queue until Play, and the landed cable is routed round the board the queue folds into. So
  // the ghost reads that board-to-be too: a queued Place's box is in its way, a queued Delete's
  // machine is not, and a queued Rotate's machine stands turned. RED before the fix: `ghostLeg`
  // read `getScene().nodes` alone.
  const inBox = (box: [number, number, number, number]) => (c: { cx: number; cy: number }): boolean =>
    c.cx >= box[0] && c.cx <= box[2] && c.cy >= box[1] && c.cy <= box[3];
  const dragAgain = (r: Rig, route: NodeView, handler: NodeView): ReturnType<typeof lastRoute> => {
    move(r, near(at(handler, 0), 8));
    move(r, near(at(handler, 0), 6));
    void route;
    return lastRoute(r);
  };

  it('WR-A-04: a queued Place between the ends is in the ghost leg\'s way', () => {
    const route = routeNode(1, 8, 8);
    const handler = handlerNode(2, 18, 7);
    rig = setupRigWith({ cellsFromWorld: true }, route, handler);
    rig.armWire();
    press(rig, at(route, 1));
    move(rig, near(at(handler, 0), 6));
    const queued = inBox([12, 7, 14, 9]);
    expect(lastRoute(rig).path.filter(queued).map(key), 'PRECONDITION: with nothing queued the leg runs row 8').toEqual([
      '12,8',
      '13,8',
      '14,8',
    ]);
    rig.claims.add(41, placeClaim({ cx: 12, cy: 7 }, 3, 3, 0, true), { generation: 0 });
    const call = dragAgain(rig, route, handler);
    const legs = [call.path, ...call.pairedLegs.map((l) => l.path)];
    expect(legs.map((path) => path.filter(queued).map(key)), 'no leg enters the queued Factory').toEqual([[], []]);
    expect([key(call.path[0]), key(call.path[call.path.length - 1])]).toEqual(['8,8', '18,8']);
    // A queued Label is a note, not a machine: a cable crosses it, so it moves nothing.
    rig.claims.end(41);
    rig.claims.add(42, placeClaim({ cx: 12, cy: 7 }, 3, 3, 0, false), { generation: 0 });
    expect(dragAgain(rig, route, handler).path.filter(queued).map(key)).toEqual(['12,8', '13,8', '14,8']);
  });

  it('WR-A-04: a queued Delete of the machine between the ends frees the ghost leg', () => {
    const route = routeNode(1, 8, 8);
    const factory = node({ id: 3, kind: machine_kind.FACTORY, cell_x: 12, cell_y: 7, w: 3, h: 3 });
    const handler = handlerNode(2, 18, 7);
    rig = setupRigWith({ cellsFromWorld: true }, route, factory, handler);
    rig.armWire();
    press(rig, at(route, 1));
    move(rig, near(at(handler, 0), 6));
    const inFactory = inBox([12, 7, 14, 9]);
    expect(lastRoute(rig).path.filter(inFactory), 'PRECONDITION: the leg goes round the Factory').toEqual([]);
    rig.claims.add(43, deleteClaim(3), { generation: 0 });
    expect(
      dragAgain(rig, route, handler).path.filter(inFactory).map(key),
      'the Factory the queue deletes is not in the way: the leg runs row 8',
    ).toEqual(['12,8', '13,8', '14,8']);
    // A Delete claim of another table's handle names another node, so it frees nothing.
    rig.claims.end(43);
    rig.claims.add(44, deleteClaim(3), { generation: 7 });
    expect(dragAgain(rig, route, handler).path.filter(inFactory)).toEqual([]);
  });

  it('WR-A-04: a queued Rotate turns the machine in the ghost leg\'s way', () => {
    // A catalog Router, 2x3 at (12,6): its box (12..13, 6..8) holds row 8. Turned, the anchor
    // holds and the box is 3x2 (12..14, 6..7), clear of row 8.
    const route = routeNode(1, 8, 8);
    const router = node({ id: 3, kind: machine_kind.ROUTER, cell_x: 12, cell_y: 6, w: 2, h: 3 });
    const handler = handlerNode(2, 18, 7);
    rig = setupRigWith({ cellsFromWorld: true }, route, router, handler);
    const centre = { x: 12.5 * CELL, y: 6.5 * CELL };
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, clientX: centre.x, clientY: centre.y });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, clientX: centre.x, clientY: centre.y });
    expect(rig.overlay.selections, 'PRECONDITION: the Router is selected').toEqual([3]);
    rig.armWire();
    press(rig, at(route, 1));
    move(rig, near(at(handler, 0), 6));
    expect(lastRoute(rig).path.filter(inBox([12, 6, 13, 8])), 'PRECONDITION: the leg goes round it').toEqual([]);
    expect(lastRoute(rig).path.map(key)).not.toContain('12,8');
    rig.destroy();

    rig = setupRigWith({ cellsFromWorld: true }, route, router, handler);
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, clientX: centre.x, clientY: centre.y });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, clientX: centre.x, clientY: centre.y });
    rig.win.fire('keydown', { key: 'r', shiftKey: false, preventDefault: () => {} });
    expect(rig.sent.map((f) => f[0]), 'PRECONDITION: one Rotate went out').toEqual([2]);
    rig.armWire();
    press(rig, at(route, 1));
    move(rig, near(at(handler, 0), 6));
    expect(
      lastRoute(rig).path.filter(inBox([12, 6, 14, 8])).map(key),
      'the queued turn leaves row 8 clear: the leg runs it',
    ).toEqual(['12,8', '13,8', '14,8']);
  });

  it('R-70: BOTH ghosts come from ONE expression, not two that agree today', () => {
    // The structural half, and it is the one that actually holds the rule. Asserting
    // that two outputs are equal on one board proves only that they agree on that
    // board; `cableLane.ts`'s header asks for ONE expression. There is exactly one
    // `wireRouteAvoiding(` call site and exactly one `cableLane(` call site in the whole
    // gesture layer, so both legs are necessarily routed and keyed by the same code.
    //
    // MOVED BY PLAN 92-03 (D-09): the counted name was `wireRoute(` and is now
    // `wireRouteAvoiding(`, the form the host's render packet calls with its machine
    // list, and the two-argument ladder is called NOWHERE in the gesture layer (count 0),
    // so no corridor can be previewed through a router that cannot see a third machine.
    //
    // COMMENTS ARE STRIPPED BEFORE COUNTING, and that is load-bearing rather than
    // fussy: this file explains itself in prose that names both functions, so a
    // count over the raw text would redden on a comment edit and go on reddening
    // until someone reworded a sentence. A guard that fires on prose teaches the
    // next reader to stop believing it.
    const src = readFileSync(join(import.meta.dirname, 'gestures.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(
      (code.match(/\bwireRouteAvoiding\(/g) ?? []).length,
      'ONE routing expression serves both ghost legs',
    ).toBe(1);
    expect(
      (code.match(/\bwireRoute\(/g) ?? []).length,
      'the two-argument ladder, blind to a third machine, routes no ghost',
    ).toBe(0);
    expect(
      (code.match(/\bcableLane\(/g) ?? []).length,
      'ONE lane expression serves both ghost legs',
    ).toBe(1);
    // ...and the stripper is not eating the code it is meant to count: the one call
    // site each of those two counts refer to is still in `code`.
    expect(code).toContain('const r = wireRouteAvoiding(from, to, machines);');
    expect(code).toContain('lane: cableLane(r.geometry.tiles),');

    // 72-16: THE ROT DECODE IS ONE EXPRESSION PER LANGUAGE, and in TypeScript that
    // expression is `effectiveBox` (footprint.ts), reached only through
    // `bodyOfNode` (wireRoute.ts). The whole reason the router is handed a RESOLVED
    // body rectangle rather than `{w, h, rot}` is that a `rot` decode would
    // otherwise be a drift surface the parity corpus CANNOT see: the corpus supplies
    // resolved rectangles as data, so a transposed w/h at a call site would pass
    // every one of its rows. A hand-written `rot & 1` in this file is exactly that
    // second decode, so the honest count is ZERO. Same stripper, same reason.
    expect(
      (code.match(/rot & 1/g) ?? []).length,
      'the rot decode lives in effectiveBox, reached through bodyOfNode — never here',
    ).toBe(0);
  });

  it('R-70: nothing in the preview tells the two ghosts apart', () => {
    // Direction is not a property the user is choosing during the drag: it is a
    // property of the pairing they are making, and marking one leg would be inventing
    // a decision they are not being asked to take. So the payload carries NO per-leg
    // colour, style, role or direction field, and the single `valid` flag colours
    // both. A later "improvement" that tinted the return leg reddens here.
    //
    // CORRECTED 2026-09-04 (phase 72 vacuity sweep, V-3), and BOTH lines were wrong in
    // the same way: each asserted over an object the TEST built, not over the payload
    // the shipped code passed.
    //
    //   - `Object.keys(call.pairedLegs[0])` read `makeOverlay`'s REBUILT `{ path, lane }`.
    //     The rebuild drops any field it does not name, so it could not see one.
    //     MEASURED: passing `[Object.assign({ reply: true }, pair.leg)]` from
    //     `gestures.ts` left this test at `1 passed | 176 skipped`. It now reads
    //     `pairedLegKeys`, snapshotted off the argument at call time.
    //   - `Object.keys({ path: call.path, lane: call.lane })` built a two-key object
    //     literal and then asserted it had two keys, which is true of every two-key
    //     object literal ever written. The forward leg is not an object in the payload
    //     at all: it is two positional arguments under the ONE shared `valid` flag. The
    //     honest statement about it is the call's ARITY, so that is what is asserted.
    const d = dragRouteToHandler();
    rig = d.rig;
    const call = lastRoute(rig);
    expect(
      call.pairedLegKeys,
      'exactly one paired leg, carrying path, lane and its own two nubs and nothing else',
    ).toEqual([['lane', 'nubs', 'path']]);
    // ...and the forward leg carries no extra field either: `showRoute(path, nubs, valid,
    // lane, pairedLegs)` is five arguments since plan 75-05 made the nubs required (D-08),
    // and a sixth is where a per-leg colour, role or direction would have to arrive.
    expect(call.argCount, 'showRoute(path, nubs, valid, lane, pairedLegs)').toBe(5);
  });

  it('R-71: the two ghosts meet only at their DOCK cells and run on neighbouring rows', () => {
    // THE FOUR-PIXEL LANE GAP IS THE DEMO BOARD'S SPECIAL CASE AND IS NOT ASSERTED
    // ANYWHERE HERE (the figure is spelled out rather than written in digits so a grep
    // for it over this file stays a real gate). `cableLane.ts:55-62` gives a pair opposite lanes of ONE corridor only when
    // the two paths are the same cell list reversed, which holds on the demo board
    // (both machines declare exactly one port, so both wires dock port 0 at both ends)
    // and is FALSE for a 3x3 Handler whose In is at local (0,1) and Out at local (2,1).
    // An earlier draft of CONTEXT carried that figure into a user-built-board claim and
    // it was corrected.
    //
    // The plan asked for DISJOINT cell lists. Measured on the plan's own worked
    // example, that is not true and cannot be: two cables terminating on the same two
    // machines necessarily share those machines' port cells.
    //
    // CORRECTED 2026-09-03 by plan 72-15, and the correction is the interesting half.
    // This test used to assert the two legs meet ONLY at dock cells and that each body
    // occupies a SINGLE row one apart. Both halves were properties of the OLD X-first
    // router on THIS ONE row-aligned fixture, and the second was already the over-claim
    // the phase-72 walk was rejected against: off this alignment the two bodies share no
    // row at all, so 'one cell apart' was never a property of the router.
    //
    // CORRECTED AGAIN 2026-09-04 by plan 72-16, and this time in the good direction.
    // Under 72-15 the pair met at the two dock cells AND at one jog cell (13,7), and
    // that shared cell was named here rather than smoothed. The perimeter ring takes
    // the return leg OUT of the forward leg's rows entirely, so the jog cell is gone
    // and the two legs now meet at the Route's cell alone:
    //
    //   forward  10,6  11,6  12,6  13,6  13,7  14,7
    //   return   16,7  17,7  17,6  17,5  16,5 ... 10,5  9,5  9,6  [10,6]
    //
    // The opposite-lane assertion below therefore stops being load-bearing for a
    // shared corridor cell and becomes what it always claimed to be on its own terms.
    // IT IS KEPT: it is a property of the pair, not of this fixture's overlap.
    const d = dragRouteToHandler();
    rig = d.rig;
    const call = lastRoute(rig);

    // The three port cells the two legs dock or pass through: the Route's single cell
    // (its In and its Out share it), the Handler's In cell, and the Handler's Out cell.
    const dockCells = new Set(['10,6', '14,7', '16,7']);
    const fwd = call.path.map(key);
    const ret = call.pairedLegs[0].path.map(key);
    const shared = fwd.filter((k) => ret.includes(k));
    expect(shared.length, 'the two legs DO meet, at the machines').toBeGreaterThan(0);
    // They meet at DOCK CELLS ONLY. 72-16 removed the single jog-cell meeting (13,7)
    // by routing the return leg around the outside of both machines.
    expect(shared.filter((k) => !dockCells.has(k)), 'no non-dock meeting at all').toEqual([]);

    // THE OPPOSITE-LANE ASSERTION IS WHAT MAKES THE SHARED CELL HARMLESS, so it is the
    // gate rather than a comment: over `13,7` the two cables are stroked on opposite
    // sides of the corridor centreline and read as two lines, not one.
    expect(call.lane, 'forward: first x 10 < last 14, the +1 lane').toBe(1);
    expect(call.pairedLegs[0].lane, 'return: first x 16 > last 10, the -1 lane').toBe(-1);
    expect(call.lane, 'and the pair is genuinely opposite').not.toBe(call.pairedLegs[0].lane);

    // THE FORWARD LEG NO LONGER ENTERS THE HANDLER'S BODY. This is the defect
    // reported on 2026-09-03 and the reason this plan exists, so it is asserted on the
    // fixture rather than left to the corpus: every 3x3 Handler cell except the In it
    // docks to is off the forward corridor.
    const handlerBody = new Set<string>();
    for (let cx = 14; cx <= 16; cx += 1) {
      for (let cy = 6; cy <= 8; cy += 1) handlerBody.add(`${cx},${cy}`);
    }
    expect(
      fwd.filter((k) => handlerBody.has(k) && k !== '14,7'),
      'the request cable touches NO Handler body cell but the In it docks to',
    ).toEqual([]);

    // AND NEITHER DOES THE RETURN LEG, as of 72-16. Under 72-15 this expectation read
    // `['15,7', '14,7']` and carried R-92's note that the crossing was DECLINED rather
    // than missed, because fixing it needed footprint knowledge and produced "a cable
    // that loops around both machines". That is precisely what was then asked for on
    // 2026-09-04, the footprint knowledge is now the `body` rectangle on `WireDock`,
    // and the loop is the shipped shape. This flipping from two cells to zero IS the
    // J-7 fix, asserted on the fixture rather than left to the corpus.
    expect(
      ret.filter((k) => handlerBody.has(k) && k !== '16,7'),
      'the reply cable touches NO Handler body cell but the Out it docks to',
    ).toEqual([]);
  });

  it('R-70: the drag made the OTHER way round previews both legs too', () => {
    // The pairing is a property of the two MACHINES, not of which nub the user pressed
    // first (`route_handler_pair` fires in either order). Dragging the Handler's Out
    // onto the Route's In must preview the same pair of corridors.
    const route = routeNode(1, 10, 6);
    const handler = handlerNode(2, 14, 6);
    rig = setupRigWith({ cellsFromWorld: true }, route, handler);
    rig.armWire();
    press(rig, at(handler, 1));
    move(rig, near(at(route, 0), -6));
    const call = lastRoute(rig);
    expect(call.valid).toBe(true);
    expect(call.pairedLegs).toHaveLength(1);
    // The drag's own leg is the return corridor; the previewed second leg is the
    // forward one. The pair on screen is the SAME pair as the other drag direction.
    expect(call.path[0]).toEqual({ cx: 16, cy: 7 });
    expect(call.path[call.path.length - 1]).toEqual({ cx: 10, cy: 6 });
    expect(call.pairedLegs[0].path[0]).toEqual({ cx: 10, cy: 6 });
    expect(call.pairedLegs[0].path[call.pairedLegs[0].path.length - 1]).toEqual({ cx: 14, cy: 7 });
  });

  it('R-70: a drag onto a ROUTER previews ONE corridor, because 72-08 mints one wire', () => {
    // The pairing is NARROW on purpose: a Router emits no `Effect::Reply`, so a return
    // leg drawn back to one is a cable that can never carry anything. 72-08 mints
    // exactly one wire for this drag, so the preview promises exactly one.
    const route = routeNode(1, 10, 6);
    const router = routerNode(2, 14, 6);
    rig = setupRigWith({ cellsFromWorld: true }, route, router);
    rig.armWire();
    press(rig, at(route, 1));
    move(rig, near(at(router, 0), -6));
    const call = lastRoute(rig);
    expect(call.valid).toBe(true);
    expect(call.pairedLegs, 'a Route-to-Router drag mints ONE wire, so ONE ghost').toEqual([]);
  });

  it('R-70: with no legal target under the pointer there is ONE ghost, unchanged', () => {
    const route = routeNode(1, 10, 6);
    const handler = handlerNode(2, 14, 6);
    rig = setupRigWith({ cellsFromWorld: true }, route, handler);
    rig.armWire();
    press(rig, at(route, 1));
    // Well outside every nub radius: the corridor ends at the pointer's own cell.
    move(rig, { x: 11 * CELL + 16, y: 20 * CELL + 16 });
    const call = lastRoute(rig);
    expect(call.valid).toBe(false);
    expect(call.pairedLegs).toEqual([]);
  });

  it('R-73: a drag onto a Handler whose Out is TAKEN previews ONE corridor, and it is RED', () => {
    // 72-08's R-52 is whole-or-nothing: the return leg is refused `PortOccupied` at
    // command.rs step 6 and the WHOLE command is refused with it, so this release mints
    // NOTHING. Previewing two blue corridors would promise two cables; previewing one
    // blue corridor would promise one. The honest preview is the shipped "this release
    // will not mint a wire" colour, over the corridor the pointer is describing.
    const d = dragRouteToHandler((r, _route, handler) => {
      r.scene.wires.set(99, {
        id: 99,
        from: { node: handler.id, port: 1 },
        to: { node: 77, port: 0 },
        path: [],
        pulses: [],
      });
    });
    rig = d.rig;
    const call = lastRoute(rig);
    expect(call.pairedLegs, 'no second cable is promised, because none will land').toEqual([]);
    expect(call.valid, 'and the one corridor drawn is NOT promised either').toBe(false);
  });
});

// ===========================================================================
// R-73: the affordance is WITHDRAWN rather than the gesture refused. Plan 72-11.
// ===========================================================================
describe('a Handler that cannot take a second pairing does not offer one (R-73)', () => {
  const ELEC = MEDIUM_ELECTRICAL;
  const MECH = MEDIUM_MECHANICAL;

  const routeNode = (id: number, cx: number, cy: number): NodeView =>
    node({
      id,
      kind: machine_kind.ENDPOINT,
      cell_x: cx,
      cell_y: cy,
      ports: [
        { index: 0, cell_x: cx, cell_y: cy, side: 3, role: 0, medium: ELEC },
        { index: 1, cell_x: cx, cell_y: cy, side: 1, role: 1, medium: ELEC },
      ],
    });
  const handlerNode = (id: number, cx: number, cy: number): NodeView =>
    node({
      id,
      kind: machine_kind.HANDLER,
      cell_x: cx,
      cell_y: cy,
      w: 3,
      h: 3,
      ports: [
        { index: 0, cell_x: cx, cell_y: cy + 1, side: 3, role: 0, medium: ELEC },
        { index: 1, cell_x: cx + 2, cell_y: cy + 1, side: 1, role: 1, medium: ELEC },
        { index: 2, cell_x: cx + 1, cell_y: cy + 2, side: 2, role: 2, medium: MECH },
      ],
    });

  const anchor = (n: NodeView, i: number): Pt =>
    nubAnchor(n.ports[i].cell_x, n.ports[i].cell_y, n.ports[i].side);
  const lastTargets = (r: Rig): Array<{ x: number; y: number; filled: boolean }> =>
    r.overlay.wireTargetCalls[r.overlay.wireTargetCalls.length - 1];
  const has = (pts: Array<{ x: number; y: number }>, pt: Pt): boolean =>
    pts.some((p) => p.x === pt.x && p.y === pt.y);

  let rig: Rig | undefined;
  afterEach(() => {
    rig?.destroy();
    rig = undefined;
  });

  it('a FREE Handler rings its In nub when the Wire tool is armed, unchanged', () => {
    const route = routeNode(1, 10, 6);
    const handler = handlerNode(2, 14, 6);
    rig = setupRigWith({ cellsFromWorld: true }, route, handler);
    rig.armWire();
    const pts = lastTargets(rig);
    expect(has(pts, anchor(handler, 0)), 'the Handler In rings while it can answer').toBe(true);
    expect(has(pts, anchor(handler, 1)), 'and so does its free Out').toBe(true);
  });

  it('a Handler whose electrical Out is TAKEN draws NO ring on its In nub', () => {
    // D-02 gives the Handler ONE electrical Out, so a Handler already answering a Route
    // cannot be paired with a second: 72-08 refuses the whole command. gestures.ts
    // already hides the ring on an Out that is taken; under D-04 the drag ENDS on an
    // In, so the suppression has to reach the In as well. The gesture is then not
    // OFFERED rather than refused after the release.
    const route = routeNode(1, 10, 6);
    const handler = handlerNode(2, 14, 6);
    rig = setupRigWith({ cellsFromWorld: true }, route, handler);
    rig.scene.wires.set(99, {
      id: 99,
      from: { node: handler.id, port: 1 },
      to: { node: route.id, port: 0 },
      path: [],
      pulses: [],
    });
    rig.armWire();
    const pts = lastTargets(rig);
    expect(has(pts, anchor(handler, 0)), 'the busy Handler stops offering its In').toBe(false);
    expect(has(pts, anchor(handler, 1)), 'its taken Out was already unringed').toBe(false);
    // THE DISCRIMINATOR: only the busy Handler goes dark. The Route's own two nubs are
    // untouched, so this is not a test that would pass against a board that rang
    // nothing at all.
    expect(has(pts, anchor(route, 0)), "the Route's In still rings").toBe(true);
    expect(has(pts, anchor(route, 1)), "the Route's Out still rings").toBe(true);
  });

  it('a busy FACTORY is not a Handler, so its In keeps its ring', () => {
    // The suppression is keyed on the HANDLER kind, which the host computes through
    // `is_handler_shape` (72-06's R-37 naming rule). A plain Factory with a taken
    // electrical Out is not a Handler and pairs with nothing, so nothing is withdrawn.
    const factory = node({
      id: 2,
      kind: machine_kind.FACTORY,
      cell_x: 14,
      cell_y: 6,
      w: 3,
      h: 3,
      ports: [
        { index: 0, cell_x: 14, cell_y: 7, side: 3, role: 0, medium: ELEC },
        { index: 1, cell_x: 16, cell_y: 7, side: 1, role: 1, medium: ELEC },
      ],
    });
    rig = setupRigWith({ cellsFromWorld: true }, factory);
    rig.scene.wires.set(99, {
      id: 99,
      from: { node: 2, port: 1 },
      to: { node: 77, port: 0 },
      path: [],
      pulses: [],
    });
    rig.armWire();
    expect(has(lastTargets(rig), anchor(factory, 0))).toBe(true);
  });

  it('there is ONE derivation of "which Outs are taken", read by the ring and the ghost', () => {
    // A second derivation would be two answers to one question inside one file, and the
    // ring and the paired-ghost preview could then disagree about whether a Handler can
    // still answer a Route: the board would offer a pairing the preview refuses, or the
    // other way round. The wire-source key is built in exactly one place.
    const src = readFileSync(join(import.meta.dirname, 'gestures.ts'), 'utf8');
    expect(
      (src.match(/w\.from\.node/g) ?? []).length,
      'the taken-Out key is built ONCE',
    ).toBe(1);
    expect(src).toContain('takenOutKeys');
  });

  it('the ring is an AFFORDANCE and not a gate: an unringed In still emits its DrawWire', () => {
    // R-73 turns `PortOccupied`'s shipped sentence into a BACKSTOP rather than the
    // ordinary experience. A backstop that could not be reached would not be one, so
    // the release on an unringed In must still ask the host and let it answer in words.
    const route = routeNode(1, 10, 6);
    const handler = handlerNode(2, 14, 6);
    rig = setupRigWith({ cellsFromWorld: true }, route, handler);
    rig.scene.wires.set(99, {
      id: 99,
      from: { node: handler.id, port: 1 },
      to: { node: 77, port: 0 },
      path: [],
      pulses: [],
    });
    rig.armWire();
    rig.canvas.fire('pointerdown', {
      button: 0,
      target: rig.canvas,
      clientX: anchor(route, 1).x,
      clientY: anchor(route, 1).y,
    });
    rig.win.fire('pointerup', {
      button: 0,
      target: rig.canvas,
      clientX: anchor(handler, 0).x + 6,
      clientY: anchor(handler, 0).y,
    });
    expect(rig.sent, 'the gesture is still SENT, and the host answers it').toHaveLength(1);
  });

  it('this plan mints NO refusal tag: it left the wire union at nineteen, grown since only by named later tags', () => {
    // A NEGATIVE claim about this plan's own scope. `PortOccupied`'s shipped sentence,
    // `That output is already connected. Disconnect it first.`, is TRUE of the second
    // pairing and names a control the panel really has. Minting a second tag to reword
    // a true sentence would cost the wire-union widening with its three pinned counts,
    // for a path the user should not be on. Exactly ONE tag is added by this whole
    // phase (`DuplicatePath`, plan 72-07's) and it was added there, not here.
    //
    // NAMED CHANGE (plan 74.1-18): this read `toHaveLength(19)` until a later phase widened
    // the union on purpose. Each later tag is listed by name, so the count still bites on
    // any tag nobody named here.
    // Plan 74.1-24 (gap J11) named `BeltJoinTurnsBack` and `BeltEndsApart`, two causes of a
    // refused belt join that carry their own sentences. Plan 74.1-32 (HEAD-WORDS) named
    // `BeltEndTaken`, a dock whose taken source is a belt's end. Plan 76-02 (phase 76)
    // named `ResizeCovers`, a size change whose new box would cover something. Plan 76-04
    // (phase 76, D-07) named `LabelDoesNotConnect`, a forged connection to a label. Plan
    // 86-06 (phase 86, D-04) named `UndoSpaceTaken`, an Undo whose restore would land on
    // cells another node now holds. Plan 88-02 (phase 88, FAIL-09, D-11) named the nine tags
    // that split `Malformed`, `OutOfBounds` and `FootprintCollision` so each sentence names one
    // cause, and `BoardChanged` (D-03), an edit whose board changed before it landed.
    const LATER_TAGS = [
      'RotateCoversBelt',
      'GrowCoversBelt',
      'InvalidBeltJoin',
      'BeltJoinTurnsBack',
      'BeltEndsApart',
      'BeltEndTaken',
      'ResizeCovers',
      'LabelDoesNotConnect',
      'UndoSpaceTaken',
      'NoSuchPort',
      'UnknownOption',
      'OverLimit',
      'InvalidPath',
      'WrongKind',
      'UndoDoesNotFit',
      'MachineTooBig',
      'RotateBlocked',
      'GrowBlocked',
      'BoardChanged',
    ];
    for (const tag of LATER_TAGS) {
      expect(Object.keys(REFUSAL_COPY), `${tag} was added by a later plan (74.1-18, 74.1-24, 74.1-32, 76-02, 76-04, 86-06 or 88-02)`).toContain(tag);
    }
    expect(Object.keys(REFUSAL_COPY)).toHaveLength(19 + LATER_TAGS.length);
    expect(REFUSAL_COPY.PortOccupied).toBe(
      'That output is already connected. Disconnect it first.',
    );
  });
});

// ===========================================================================
// Phase 74 (LINK-02 / LINK-10 / LINK-03): a belt end is a target
// ===========================================================================
//
// WINDOWS 140, observed on the real binary: dragging a belt end onto another belt's end
// produced no dock AND no visible refusal. Both halves are here - the belt end
// entering the ONE hit set (so the gesture reaches a command at all), and the target
// rings (so the board says where a drop can land before the drag).
describe('belt ends are dock targets (LINK-02 / LINK-10)', () => {
  let rig: Rig | null = null;
  afterEach(() => {
    rig?.destroy();
    rig = null;
  });

  const hTile = (cx: number, cy: number): TileView => ({
    cell_x: cx,
    cell_y: cy,
    kind: { Straight: { axis: 0 } },
  });
  const mkBelt = (
    id: number,
    tiles: TileView[],
    docks: BeltView['docks'] = [],
  ): BeltView => ({ id, latency: 4 * tiles.length, fill: 0, items: [], tiles, docks, ticks_per_slot: 1 });

  /** The world centre of a cell - a belt end's hit point and its ring centre. */
  const centre = (cx: number, cy: number): Pt => ({ x: cx * CELL + CELL / 2, y: cy * CELL + CELL / 2 });
  /** A pointer event at a WORLD point (the rig's cam is identity screen<->world). */
  const atW = (p: Pt) => ({ clientX: p.x, clientY: p.y });

  /** `up` runs east ending at (3,0); `down` runs east from (4,0). They ABUT. */
  const upBelt = (docks: BeltView['docks'] = []): BeltView =>
    mkBelt(21, [hTile(2, 0), hTile(3, 0)], docks);
  const downBelt = (docks: BeltView['docks'] = []): BeltView =>
    mkBelt(22, [hTile(4, 0), hTile(5, 0)], docks);

  const lastDockTargets = (r: Rig): Array<{ x: number; y: number; filled: boolean }> =>
    r.overlay.dockTargetCalls[r.overlay.dockTargetCalls.length - 1] ?? [];

  // -------------------------------------------------------------------------
  // LINK-02: the handle drag
  // -------------------------------------------------------------------------

  it('dragging a selected belt HEAD onto another belt TAIL emits EXACTLY ONE Dock naming that belt', () => {
    // The gesture WINDOWS 140 measured as silently inert. `node` carries the TARGET
    // BELT's dense handle, which `command.rs` resolves exactly as it resolves a
    // machine's, and `port` is the target's Tail catalog index - `Role::In`, declared
    // FIRST, so 0.
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, upBelt());
    rig.scene.belts.set(22, downBelt());
    // Select `up` by press-then-release on one of its tiles.
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(centre(2, 0)) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW(centre(2, 0)) });
    rig.sent.length = 0;

    // Grab the Head handle at (3,0) and release on `down`'s Tail at (4,0).
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(centre(3, 0)) });
    rig.win.fire('pointermove', { target: rig.canvas, ...atW(centre(4, 0)) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW(centre(4, 0)) });

    // THE COUNT, not the presence: a spec that asserted only "a Dock appeared" would
    // pass on a build that emitted three.
    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 21, end: 'Head', node: 22, port: 0 }),
    ]);
    // Wire layout: [disc=4, belt=21, end Head=0, node=22, port=0].
    expect([...rig.sent[0]]).toEqual([4, 21, 0, 22, 0]);
  });

  it('the drag addresses the belt end and NOT the belt itself: node is the partner handle', () => {
    // NON-VACUITY for the case above. On a board where the OTHER belt is moved one
    // cell further away it is out of the 12 world px radius, no candidate is set, and
    // the release is the documented CANCEL: no command at all.
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, upBelt());
    rig.scene.belts.set(22, mkBelt(22, [hTile(6, 0), hTile(7, 0)]));
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(centre(2, 0)) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW(centre(2, 0)) });
    rig.sent.length = 0;

    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(centre(3, 0)) });
    rig.win.fire('pointermove', { target: rig.canvas, ...atW({ x: 4 * CELL + CELL / 2, y: 16 }) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW({ x: 4 * CELL + CELL / 2, y: 16 }) });
    expect(rig.sent).toHaveLength(0);
  });

  it('a press-and-release WITHOUT moving is still the documented CANCEL, not a self-dock', () => {
    // THE REGRESSION THIS EXCLUSION EXISTS FOR. The dragged end's own nub sits at its
    // unmoved tile centre, so with belt ends in the hit set and no exclusion, the
    // release would address the belt's OWN end and emit a self-`Dock` the host refuses
    // in words - the app arguing with a user who deliberately backed out
    // (`21-UI-SPEC.md:137`, "No command; handle snaps back").
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, upBelt());
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(centre(2, 0)) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW(centre(2, 0)) });
    rig.sent.length = 0;

    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(centre(3, 0)) });
    // A MOVE IS FIRED, and its absence was a hole. `updateDropCandidate` runs on MOVE
    // only, so a press-then-up with no move in between leaves the candidate null for
    // ANY implementation - including one with no own-end exclusion at all. The mutation
    // that deletes the exclusion survived the first draft of this case for exactly that
    // reason. A real pointer always emits at least one move; so does this one now.
    rig.win.fire('pointermove', { target: rig.canvas, ...atW(centre(3, 0)) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW(centre(3, 0)) });
    expect(rig.sent).toHaveLength(0);
  });

  it('T-74-22: at the DEFAULT radius a press at the seam reaches exactly ONE end', () => {
    // The measured basis of "the default radius, never the wire one". Two abutting end
    // tile centres are CELL = 32 world px apart, so at radius 12 the two hit circles do
    // not intersect and the 8 px band on either side of the seam reaches one end only.
    // At `wireNubHitRadiusWorld` = 22 they overlap in a 12 px band straddling the seam
    // and which end the user grabbed would be decided by arbitration they cannot see.
    const up = centre(3, 0);
    const down = centre(4, 0);
    expect(Math.abs(down.x - up.x)).toBe(CELL);
    expect(nubHitRadiusWorld(1) * 2).toBeLessThan(CELL);
    expect(wireNubHitRadiusWorld(1) * 2).toBeGreaterThan(CELL);

    // Behaviourally: a drag released 10 px short of `down`'s centre - inside `down`'s
    // 12 px radius and OUTSIDE `up`'s - addresses `down` and nothing else.
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, upBelt());
    rig.scene.belts.set(22, downBelt());
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(centre(2, 0)) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW(centre(2, 0)) });
    rig.sent.length = 0;
    const near = { x: down.x - 10, y: down.y };
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(up) });
    rig.win.fire('pointermove', { target: rig.canvas, ...atW(near) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW(near) });
    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([4, 21, 0, 22, 0]);
  });

  // -------------------------------------------------------------------------
  // GAP N4b (plan 74.1-15): a JOINED belt end grabs from its end TILE
  // -------------------------------------------------------------------------
  //
  // Once two belts join, each joined end's grab dot is drawn at the SEAM (the shared
  // edge), 16 world px from the end tile centre, outside the 12 px hit radius at scale
  // 1, so a press on the end tile grabbed nothing (user report: "on all belts I see only ends
  // to drag"). `hitHandle` now takes a press anywhere inside exactly one end tile of the
  // selected multi-tile belt as a grab of that end. Every press below is OFF-CENTRE.

  /** `up` (2,0)->(3,0) and `down` (4,0)->(5,0), JOINED: up's Head feeds down's Tail. */
  const joinedPair = (r: Rig): void => {
    r.scene.belts.set(21, upBelt([{ end: 'Head', node: 22, port: 0 }]));
    r.scene.belts.set(22, downBelt([{ end: 'Tail', node: 21, port: 1 }]));
  };
  /** A world point at fraction (fx, fy) of cell (cx, cy). */
  const frac = (cx: number, cy: number, fx: number, fy: number): Pt => ({
    x: (cx + fx) * CELL,
    y: (cy + fy) * CELL,
  });
  /** A pointer event at a WORLD point, through a camera at `scale`. */
  const atS = (p: Pt, scale: number) => ({ clientX: p.x * scale, clientY: p.y * scale });
  /** Press-then-release at a world point: selects whatever is there. */
  const clickW = (r: Rig, p: Pt, scale: number): void => {
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...atS(p, scale) });
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...atS(p, scale) });
  };

  for (const scale of [1, 0.25]) {
    it(`a JOINED Head pressed off-centre inside its end tile grabs the Head at scale ${scale}`, () => {
      rig = setupRigWith({ cellsFromWorld: true, scale });
      joinedPair(rig);
      // A third belt whose Tail (3,1) sits under up's Head, the drop that proves WHICH end
      // the press grabbed.
      rig.scene.belts.set(23, mkBelt(23, [hTile(3, 1), hTile(3, 2)]));
      clickW(rig, centre(2, 0), scale);
      rig.sent.length = 0;
      // Measured: up's Head grab dot is the seam (128, 16); this press (105.6, 22.4) is
      // 23 world px from it and 26 from the Tail dot (80, 16), inside tile (3,0).
      const press = frac(3, 0, 0.3, 0.7);
      rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atS(press, scale) });
      expect(rig.cursor(), 'the press began a handle drag').toBe('grabbing');
      rig.win.fire('pointermove', { target: rig.canvas, ...atS(centre(3, 1), scale) });
      // NAMED CHANGE (plan 74.1-25, review WR-03). This case used to stop at the Dock and so
      // presented it as a success. Belt 21's Head is already JOINED (to belt 22), and the
      // host refuses every second Head dock (`BeltEndTaken` since plan 74.1-32, `PortOccupied`
      // before it; `a_second_head_dock_is_refused_and_the_first_join_survives_byte_for_byte`), so the
      // drop ring is PASSIVE over the target, and no resting ring promises a join anywhere.
      // The grab and the one emitted Dock stand: the ring is a prediction, never a gate
      // (D-07), and the host answers the drop in words.
      expect(
        rig.overlay.nubRingCalls[rig.overlay.nubRingCalls.length - 1],
        'the drop ring over belt 23\'s Tail is passive: the host will refuse it BeltEndTaken',
      ).toEqual({ pt: centre(3, 1), armed: false });
      expect(lastDockTargets(rig), 'a joined Head is offered no join anywhere').toEqual([]);
      rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atS(centre(3, 1), scale) });
      expect(rig.sent).toHaveLength(1);
      expect([...rig.sent[0]], 'the Dock the host refuses BeltEndTaken is still SENT').toEqual([
        ...encodeGridCommand({ kind: 'Dock', belt: 21, end: 'Head', node: 23, port: 0 }),
      ]);
    });

    it(`a JOINED Tail pressed off-centre inside its end tile grabs the Tail at scale ${scale}`, () => {
      rig = setupRigWith({ cellsFromWorld: true, scale });
      joinedPair(rig);
      // A third belt whose Head (4,1) sits under down's Tail.
      rig.scene.belts.set(24, mkBelt(24, [hTile(4, 2), hTile(4, 1)]));
      clickW(rig, centre(5, 0), scale);
      rig.sent.length = 0;
      // Measured: down's Tail grab dot is the seam (128, 16); this press (150.4, 22.4) is
      // 23 world px from it and 26 from the Head dot (176, 16), inside tile (4,0).
      const press = frac(4, 0, 0.7, 0.7);
      rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atS(press, scale) });
      expect(rig.cursor(), 'the press began a handle drag').toBe('grabbing');
      rig.win.fire('pointermove', { target: rig.canvas, ...atS(centre(4, 1), scale) });
      rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atS(centre(4, 1), scale) });
      expect(rig.sent).toHaveLength(1);
      expect([...rig.sent[0]]).toEqual([
        ...encodeGridCommand({ kind: 'Dock', belt: 22, end: 'Tail', node: 24, port: 1 }),
      ]);
    });
  }

  it('a press inside NEITHER end tile keeps the nearest-dot rule (a seam dot reached from the partner tile)', () => {
    rig = setupRigWith({ cellsFromWorld: true });
    joinedPair(rig);
    clickW(rig, centre(5, 0), 1);
    // Inside up's tile (3,0), which is not one of down's tiles, 6 px from down's Tail seam
    // dot (128, 16): the radius rule grabs down's Tail, as before.
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW({ x: 122, y: 16 }) });
    expect(rig.cursor()).toBe('grabbing');
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW({ x: 122, y: 16 }) });
  });

  it('a press ON the edge between the two tiles of a two-tile belt is in both end tiles, so the nearest-dot rule decides (nothing in reach)', () => {
    rig = setupRigWith({ cellsFromWorld: true });
    joinedPair(rig);
    clickW(rig, centre(2, 0), 1);
    // x = 96 is the shared edge of (2,0) and (3,0): 16 px from the Tail dot (80, 16) and
    // 32 from the Head's seam dot (128, 16). Neither is within 12, so no drag begins.
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW({ x: 96, y: 16 }) });
    expect(rig.cursor()).not.toBe('grabbing');
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW({ x: 96, y: 16 }) });
  });

  it('a single-tile belt keeps the nearest-dot rule: a press in its tile but outside the radius grabs nothing', () => {
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(25, mkBelt(25, [hTile(8, 0)]));
    clickW(rig, centre(8, 0), 1);
    // (257.6, 30.4) is inside tile (8,0) and 20 px from its one dot (272, 16).
    const far = frac(8, 0, 0.05, 0.95);
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(far) });
    expect(rig.cursor(), 'outside the radius: no drag').not.toBe('grabbing');
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW(far) });
    // Inside the radius it still grabs (9 px from the dot).
    const near = frac(8, 0, 0.3, 0.3);
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(near) });
    expect(rig.cursor(), 'inside the radius: a drag').toBe('grabbing');
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW(near) });
  });

  // -------------------------------------------------------------------------
  // GAP N4-DROP (plan 74.1-25): a dot DROPPED anywhere on the target END tile lands
  // -------------------------------------------------------------------------
  //
  // The re-walk (REWALK-2 N4A/N4B/N4D): a press anywhere on an end tile picks the end up
  // (the 74.1-15 cases above), but a drop more than about 13 screen px from the target
  // tile's centre snapped back with nothing sent and nothing said, because the drop read a
  // 12 world px disc around the target's end point. The drop now reads the press side's
  // rule: another belt's end whose END TILE contains the pointer (closed bounds) is a
  // candidate ahead of the radius hits; accepting first, then nearest.
  //
  // THE BOARD IS N4A's: the main belt (4,6)->(7,6) east, the side belt (4,3)->(4,5) south,
  // ending on the tile just above the main belt's Tail. Every gesture moves like a hand:
  // an off-centre press inside the main belt's first tile, a sub-cell sample still inside
  // it, then the drop point, which is never a tile centre.
  describe('a belt-end dot dropped anywhere on the target end tile lands (plan 74.1-25, N4-DROP)', () => {
    const MAIN = 31;
    const SIDE = 32;
    const vTile = (cx: number, cy: number): TileView => ({
      cell_x: cx,
      cell_y: cy,
      kind: { Straight: { axis: 1 } },
    });
    const n4aBoard = (r: Rig): void => {
      r.scene.belts.set(MAIN, mkBelt(MAIN, [hTile(4, 6), hTile(5, 6), hTile(6, 6), hTile(7, 6)]));
      r.scene.belts.set(SIDE, mkBelt(SIDE, [vTile(4, 3), vTile(4, 4), vTile(4, 5)]));
    };
    /** The one Dock the N4A drop must send: main's Tail onto the side belt's Head (catalog 1). */
    const JOIN = (): number[] => [
      ...encodeGridCommand({ kind: 'Dock', belt: MAIN, end: 'Tail', node: SIDE, port: 1 }),
    ];
    /**
     * Select the main belt, press off-centre inside its first tile (4,6), take one sub-cell
     * sample still inside that tile, move to `drop` and release there. Nothing else.
     */
    const dragMainTailTo = (r: Rig, drop: Pt, scale: number): void => {
      clickW(r, centre(6, 6), scale);
      r.sent.length = 0;
      const press = frac(4, 6, 0.7, 0.7);
      r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...atS(press, scale) });
      expect(r.cursor(), 'the press inside the first tile began a handle drag').toBe('grabbing');
      r.win.fire('pointermove', { target: r.canvas, ...atS(frac(4, 6, 0.6, 0.55), scale) });
      r.win.fire('pointermove', { target: r.canvas, ...atS(drop, scale) });
      r.win.fire('pointerup', { button: 0, target: r.canvas, ...atS(drop, scale) });
    };

    // The side belt's last tile is (4,5): world x 128..160, y 160..192, centre (144, 176).
    // The corners are inset 1 world px (21.2 world px from the centre, outside the 12 px
    // radius at scale 1); the edge midpoints sit ON the tile's closed edge (16 px out).
    const CORNERS: Array<[string, Pt]> = [
      ['top-left corner', { x: 129, y: 161 }],
      ['top-right corner', { x: 159, y: 161 }],
      ['bottom-left corner', { x: 129, y: 191 }],
      ['bottom-right corner', { x: 159, y: 191 }],
    ];
    const MIDPOINTS: Array<[string, Pt]> = [
      ['top edge midpoint', { x: 144, y: 160 }],
      ['right edge midpoint', { x: 160, y: 176 }],
      ['bottom edge midpoint', { x: 144, y: 192 }],
      ['left edge midpoint', { x: 128, y: 176 }],
    ];

    for (const scale of [1, 0.25]) {
      for (const [where, drop] of [...CORNERS, ...MIDPOINTS]) {
        it(`a drop at the ${where} of the side belt's last tile sends ONE Dock naming its Head, at scale ${scale}`, () => {
          rig = setupRigWith({ cellsFromWorld: true, scale });
          n4aBoard(rig);
          dragMainTailTo(rig, drop, scale);
          expect(rig.sent, `exactly one Dock for a drop at the ${where}`).toHaveLength(1);
          expect([...rig.sent[0]]).toEqual(JOIN());
          expect(
            rig.overlay.nubRingCalls[rig.overlay.nubRingCalls.length - 1],
            'the drop ring sat on the side belt\'s last tile, painted accepting',
          ).toEqual({ pt: centre(4, 5), armed: true });
        });
      }
    }

    it('on the edge two end tiles share: just inside either tile addresses THAT end; exactly on it, the accepting end wins', () => {
      // A second belt X ends at (3,5), beside the side belt's last tile (4,5); the two end
      // tiles share the edge x = 128. X's Head is a diagonal step from the main belt's Tail
      // (4,6), so the host refuses it (BeltEndsApart) and it never paints accepting.
      const X = 33;
      const board = (r: Rig): void => {
        n4aBoard(r);
        r.scene.belts.set(X, mkBelt(X, [hTile(1, 5), hTile(2, 5), hTile(3, 5)]));
      };
      const xHead = [
        ...encodeGridCommand({ kind: 'Dock', belt: MAIN, end: 'Tail', node: X, port: 1 }),
      ];
      // 1 world px inside (3,5): 15 px from X's centre (112, 176) and 17 from the side's
      // (144, 176). X's end is the nearer, and it is addressed though it does not accept:
      // the ranker is never a gate, the host answers in words.
      rig = setupRigWith({ cellsFromWorld: true });
      board(rig);
      dragMainTailTo(rig, { x: 127, y: 176 }, 1);
      expect(rig.sent).toHaveLength(1);
      expect([...rig.sent[0]], 'just inside (3,5): X\'s Head, the nearer end').toEqual(xHead);
      expect(rig.overlay.nubRingCalls[rig.overlay.nubRingCalls.length - 1]).toEqual({
        pt: centre(3, 5),
        armed: false,
      });
      rig.destroy();
      // 1 world px inside (4,5): the side belt's Head, the nearer end.
      rig = setupRigWith({ cellsFromWorld: true });
      board(rig);
      dragMainTailTo(rig, { x: 129, y: 176 }, 1);
      expect(rig.sent).toHaveLength(1);
      expect([...rig.sent[0]], 'just inside (4,5): the side belt\'s Head').toEqual(JOIN());
      rig.destroy();
      // ON the shared edge, x = 128: both closed tiles contain it, both centres are 16 px
      // away, and the accepting end is ranked first.
      rig = setupRigWith({ cellsFromWorld: true });
      board(rig);
      dragMainTailTo(rig, { x: 128, y: 176 }, 1);
      expect(rig.sent).toHaveLength(1);
      expect([...rig.sent[0]], 'on the shared edge: the accepting end').toEqual(JOIN());
    });

    for (const scale of [1, 0.25]) {
      it(`a drop on the dragged belt's OWN end tile sends nothing, at scale ${scale}`, () => {
        rig = setupRigWith({ cellsFromWorld: true, scale });
        n4aBoard(rig);
        // Inside the main belt's own Head tile (7,6), off-centre: its own end is never a
        // target, so the release is the documented cancel.
        dragMainTailTo(rig, frac(7, 6, 0.8, 0.2), scale);
        expect(rig.sent, 'the own Head tile: nothing sent').toHaveLength(0);
        if (scale === 1) {
          // And back on its own Tail tile, off the press point. Scale 1 only: at 0.25 the
          // radius rule (48 world px there) still reaches the side belt's end 46 px away,
          // which is the radius fallback both the press and the drop keep, not this rule.
          rig.destroy();
          rig = setupRigWith({ cellsFromWorld: true, scale });
          n4aBoard(rig);
          dragMainTailTo(rig, frac(4, 6, 0.2, 0.9), scale);
          expect(rig.sent, 'the own Tail tile: nothing sent').toHaveLength(0);
        }
      });

      it(`a drop on empty floor sends nothing, at scale ${scale}`, () => {
        rig = setupRigWith({ cellsFromWorld: true, scale });
        n4aBoard(rig);
        dragMainTailTo(rig, frac(10, 10, 0.3, 0.6), scale);
        expect(rig.sent).toHaveLength(0);
      });
    }
  });

  // -------------------------------------------------------------------------
  // WR-03 (round 3) and FINDING N4-RING (plan 74.1-25): every ring a drag paints is a join
  // -------------------------------------------------------------------------
  //
  // Two occupancy terms join the drop ranker beside `acceptsDock`, mirroring the host's
  // occupancy arm (its belt-end half is `BeltEndTaken` since plan 74.1-32): a dragged Head that already carries a Head dock accepts nowhere,
  // and a target Head that already carries a dock does not accept a Tail. During a handle
  // drag the resting rings are exactly the targets that predicate accepts for the dragged
  // end's FIXED cell (the carrier does not move during the drag). Every release over a
  // target still SENDS its one Dock (D-07); only the paint changes.
  describe('rings during a handle drag paint only joins the host will make (plan 74.1-25, WR-03, N4-RING)', () => {
    const vTile = (cx: number, cy: number): TileView => ({
      cell_x: cx,
      cell_y: cy,
      kind: { Straight: { axis: 1 } },
    });
    const lastNubRing = (r: Rig): { pt: Pt; armed: boolean } | undefined =>
      r.overlay.nubRingCalls[r.overlay.nubRingCalls.length - 1];
    /**
     * Select belt `select` by a click on `selectCell`, press off-centre inside `pressCell`
     * (the end tile), take a sub-cell sample inside it, move to `drop`. NO release: the
     * caller reads the rings mid-drag, then releases with {@link releaseAt}.
     */
    const grabAndHover = (r: Rig, selectCell: [number, number], pressCell: [number, number], drop: Pt): void => {
      clickW(r, centre(...selectCell), 1);
      r.sent.length = 0;
      r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...atW(frac(...pressCell, 0.7, 0.7)) });
      expect(r.cursor(), 'the press began a handle drag').toBe('grabbing');
      r.win.fire('pointermove', { target: r.canvas, ...atW(frac(...pressCell, 0.6, 0.55)) });
      r.win.fire('pointermove', { target: r.canvas, ...atW(drop) });
    };
    const releaseAt = (r: Rig, drop: Pt): void => {
      r.win.fire('pointerup', { button: 0, target: r.canvas, ...atW(drop) });
    };
    const hasRingAt = (pts: Array<{ x: number; y: number }>, p: Pt): boolean =>
      pts.some((q) => q.x === p.x && q.y === p.y);

    it('a Tail dragged onto a belt whose Head already carries a dock: passive ring, no resting ring, one Dock sent', () => {
      // N4A's board, the side belt's Head (4,5) already docked sideways to belt 34's Tail
      // (3,5). A second outgoing link from that Head is refused `BeltEndTaken` (plan 74.1-32).
      rig = setupRigWith({ cellsFromWorld: true });
      rig.scene.belts.set(31, mkBelt(31, [hTile(4, 6), hTile(5, 6), hTile(6, 6), hTile(7, 6)]));
      rig.scene.belts.set(
        32,
        mkBelt(32, [vTile(4, 3), vTile(4, 4), vTile(4, 5)], [{ end: 'Head', node: 34, port: 0 }]),
      );
      rig.scene.belts.set(34, mkBelt(34, [hTile(3, 5), hTile(2, 5)], [{ end: 'Tail', node: 32, port: 1 }]));
      const drop = frac(4, 5, 0.4, 0.6);
      grabAndHover(rig, [6, 6], [4, 6], drop);
      expect(lastNubRing(rig), 'the drop ring over the taken Head is passive').toEqual({
        pt: centre(4, 5),
        armed: false,
      });
      expect(hasRingAt(lastDockTargets(rig), centre(4, 5)), 'no resting ring on the taken Head').toBe(false);
      releaseAt(rig, drop);
      expect(rig.sent).toHaveLength(1);
      expect([...rig.sent[0]], 'the Dock the host refuses BeltEndTaken is still SENT').toEqual([
        ...encodeGridCommand({ kind: 'Dock', belt: 31, end: 'Tail', node: 32, port: 1 }),
      ]);
    });

    // N4D: the top belt (4,6)->(7,6) east and the bottom belt (7,7)->(5,7) west, starting
    // right under the top belt's last tile. Both drag directions are a U-turn the host
    // refuses `BeltJoinTurnsBack`.
    const n4dBoard = (r: Rig): void => {
      r.scene.belts.set(41, mkBelt(41, [hTile(4, 6), hTile(5, 6), hTile(6, 6), hTile(7, 6)]));
      r.scene.belts.set(42, mkBelt(42, [hTile(7, 7), hTile(6, 7), hTile(5, 7)]));
    };
    const N4D_WAYS: Array<{
      name: string;
      select: [number, number];
      press: [number, number];
      target: [number, number];
      dock: number[];
    }> = [
      {
        name: 'way 1: the top belt last tile dragged onto the bottom belt first tile',
        select: [5, 6],
        press: [7, 6],
        target: [7, 7],
        dock: [...encodeGridCommand({ kind: 'Dock', belt: 41, end: 'Head', node: 42, port: 0 })],
      },
      {
        name: 'way 2: the bottom belt first tile dragged onto the top belt last tile',
        select: [6, 7],
        press: [7, 7],
        target: [7, 6],
        dock: [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Tail', node: 41, port: 1 })],
      },
    ];
    for (const way of N4D_WAYS) {
      it(`N4D ${way.name}: no accepting drop ring and no resting ring at the U-turn target; the Dock is sent`, () => {
        rig = setupRigWith({ cellsFromWorld: true });
        n4dBoard(rig);
        const drop = frac(...way.target, 0.4, 0.6);
        grabAndHover(rig, way.select, way.press, drop);
        expect(hasRingAt(lastDockTargets(rig), centre(...way.target)), 'no resting ring at the U-turn target').toBe(
          false,
        );
        expect(lastNubRing(rig), 'the drop ring is passive').toEqual({ pt: centre(...way.target), armed: false });
        releaseAt(rig, drop);
        expect(rig.sent).toHaveLength(1);
        expect([...rig.sent[0]]).toEqual(way.dock);
      });
    }

    it('N4E: no resting ring and no accepting drop ring at a belt end two tiles away', () => {
      // The upper belt (4,2)->(4,4) south ends two tiles above the main belt's Tail (4,6).
      rig = setupRigWith({ cellsFromWorld: true });
      rig.scene.belts.set(31, mkBelt(31, [hTile(4, 6), hTile(5, 6), hTile(6, 6), hTile(7, 6)]));
      rig.scene.belts.set(35, mkBelt(35, [vTile(4, 2), vTile(4, 3), vTile(4, 4)]));
      const drop = frac(4, 6, 0.4, 0.6);
      grabAndHover(rig, [4, 3], [4, 4], drop);
      expect(hasRingAt(lastDockTargets(rig), centre(4, 6)), 'no resting ring two tiles away').toBe(false);
      expect(lastDockTargets(rig), 'nothing on this board joins the upper belt Head').toEqual([]);
      expect(lastNubRing(rig), 'the drop ring is passive').toEqual({ pt: centre(4, 6), armed: false });
      releaseAt(rig, drop);
      expect(rig.sent, 'the drop is still sent, for the host to answer').toHaveLength(1);
    });

    it('N4A: the side belt last tile wears an accepting drop ring and the one resting ring', () => {
      rig = setupRigWith({ cellsFromWorld: true });
      rig.scene.belts.set(31, mkBelt(31, [hTile(4, 6), hTile(5, 6), hTile(6, 6), hTile(7, 6)]));
      rig.scene.belts.set(32, mkBelt(32, [vTile(4, 3), vTile(4, 4), vTile(4, 5)]));
      const drop = frac(4, 5, 0.4, 0.6);
      grabAndHover(rig, [6, 6], [4, 6], drop);
      expect(lastDockTargets(rig)).toEqual([{ ...centre(4, 5), filled: false }]);
      expect(lastNubRing(rig)).toEqual({ pt: centre(4, 5), armed: true });
      releaseAt(rig, drop);
      expect(rig.sent).toHaveLength(1);
      expect([...rig.sent[0]]).toEqual([
        ...encodeGridCommand({ kind: 'Dock', belt: 31, end: 'Tail', node: 32, port: 1 }),
      ]);
    });

    // REVIEW ROUND 4 WR-02 (plan 74.1-33): the most common drag there is. A selected belt's
    // Tail already docked to a machine Out sits on that Out's doorstep, so the geometry
    // accepts it, and the host's Tail arm then finds the existing link and refuses
    // `PortOccupied`. The predicate carries the host's third occupancy term: a Tail does not
    // accept a machine Out or Fault that any belt's Tail dock already names, in the dock
    // records' keyspace (an Out by its ordinal among the node's Outs, a Fault by the
    // `FAULT_PORT` sentinel). Every release still SENDS its one Dock (D-07).
    //
    // Board: belt 22 runs east (4,0)->(5,0), its Tail on (4,0). Source 11 at (4,1) has its
    // Out on the north side, doorstep (4,0): the Tail's own tile.
    const sourceBelow = (): NodeView =>
      node({
        id: 11,
        kind: machine_kind.SOURCE,
        cell_x: 4,
        cell_y: 1,
        ports: [{ index: 0, cell_x: 4, cell_y: 1, side: 0, role: 1, medium: 0 }],
      });
    /** A point two px off the nub's centre, the way a hand lands on a 7 px ring. */
    const nearNub = (cx: number, cy: number, side: number): Pt => {
      const n = nubAnchor(cx, cy, side);
      return { x: n.x + 2, y: n.y - 1 };
    };

    it('WR-02: a Tail docked to a Source Out, dragged by its dot, rings nothing on that Out and the drop ring is refused; one Dock is sent', () => {
      rig = setupRigWith({ cellsFromWorld: true }, sourceBelow());
      rig.scene.belts.set(22, mkBelt(22, [hTile(4, 0), hTile(5, 0)], [{ end: 'Tail', node: 11, port: 0 }]));
      const drop = nearNub(4, 1, 0);
      grabAndHover(rig, [5, 0], [4, 0], drop);
      expect(
        hasRingAt(lastDockTargets(rig), nubAnchor(4, 1, 0)),
        'no resting ring on the Out this Tail is already docked to',
      ).toBe(false);
      expect(lastNubRing(rig), 'the drop ring over the docked Out is drawn refused').toEqual({
        pt: nubAnchor(4, 1, 0),
        armed: false,
      });
      releaseAt(rig, drop);
      expect(rig.sent).toHaveLength(1);
      expect([...rig.sent[0]], 'the Dock the host refuses PortOccupied is still SENT').toEqual([
        ...encodeGridCommand({ kind: 'Dock', belt: 22, end: 'Tail', node: 11, port: 0 }),
      ]);
    });

    it('WR-02 keyspace: a Tail docked to a Router second Out (ordinal 1, catalog index 2) rings nothing on it', () => {
      // The dock record names an Out by its ORDINAL among the node's Outs (`dock_link_key`),
      // not by its catalog index, so a comparison against `port.index` would miss this Out.
      const router = node({
        id: 12,
        kind: machine_kind.ROUTER,
        cell_x: 3,
        cell_y: 1,
        w: 2,
        h: 1,
        ports: [
          { index: 0, cell_x: 3, cell_y: 1, side: 3, role: 0, medium: 0 },
          { index: 1, cell_x: 3, cell_y: 1, side: 2, role: 1, medium: 0 },
          { index: 2, cell_x: 4, cell_y: 1, side: 0, role: 1, medium: 0 },
        ],
      });
      rig = setupRigWith({ cellsFromWorld: true }, router);
      rig.scene.belts.set(22, mkBelt(22, [hTile(4, 0), hTile(5, 0)], [{ end: 'Tail', node: 12, port: 1 }]));
      const drop = nearNub(4, 1, 0);
      grabAndHover(rig, [5, 0], [4, 0], drop);
      expect(hasRingAt(lastDockTargets(rig), nubAnchor(4, 1, 0)), 'no resting ring on the docked second Out').toBe(
        false,
      );
      expect(lastNubRing(rig)).toEqual({ pt: nubAnchor(4, 1, 0), armed: false });
      releaseAt(rig, drop);
      expect(rig.sent).toHaveLength(1);
      expect([...rig.sent[0]]).toEqual([
        ...encodeGridCommand({ kind: 'Dock', belt: 22, end: 'Tail', node: 12, port: 2 }),
      ]);
    });

    it('WR-02 control: a FREE Out beside the docked one still rings and its drop ring accepts', () => {
      // Source 13 at (3,0) faces east onto the same doorstep (4,0), head-on to the Tail.
      const sourceWest = node({
        id: 13,
        kind: machine_kind.SOURCE,
        cell_x: 3,
        cell_y: 0,
        ports: [{ index: 0, cell_x: 3, cell_y: 0, side: 1, role: 1, medium: 0 }],
      });
      rig = setupRigWith({ cellsFromWorld: true }, sourceBelow(), sourceWest);
      rig.scene.belts.set(22, mkBelt(22, [hTile(4, 0), hTile(5, 0)], [{ end: 'Tail', node: 11, port: 0 }]));
      const drop = nearNub(3, 0, 1);
      grabAndHover(rig, [5, 0], [4, 0], drop);
      expect(lastDockTargets(rig), 'the free Out rings; the docked one does not').toEqual([
        { ...nubAnchor(3, 0, 1), filled: false },
      ]);
      expect(lastNubRing(rig)).toEqual({ pt: nubAnchor(3, 0, 1), armed: true });
      releaseAt(rig, drop);
      expect(rig.sent).toHaveLength(1);
      expect([...rig.sent[0]]).toEqual([
        ...encodeGridCommand({ kind: 'Dock', belt: 22, end: 'Tail', node: 13, port: 0 }),
      ]);
    });

    it('WR-02 Fault: a Fault already docked by ANOTHER belt Tail does not ring for this Tail', () => {
      // A Factory-like box with two Faults. Belt 23's Tail drains the first Fault; the host
      // keys every Fault link on `FAULT_PORT`, so a Tail dock onto the SECOND Fault is
      // refused `PortOccupied` too, and the dock record says `port: FAULT_PORT`.
      const box = node({
        id: 14,
        kind: machine_kind.FACTORY,
        cell_x: 4,
        cell_y: 1,
        w: 2,
        h: 1,
        ports: [
          { index: 0, cell_x: 5, cell_y: 1, side: 2, role: 0, medium: 0 },
          { index: 1, cell_x: 4, cell_y: 1, side: 2, role: 1, medium: 0 },
          { index: 2, cell_x: 5, cell_y: 1, side: 0, role: 2, medium: 0 },
          { index: 3, cell_x: 4, cell_y: 1, side: 0, role: 2, medium: 0 },
        ],
      });
      rig = setupRigWith({ cellsFromWorld: true }, box);
      rig.scene.belts.set(23, mkBelt(23, [vTile(5, 0), vTile(5, -1)], [{ end: 'Tail', node: 14, port: FAULT_PORT }]));
      rig.scene.belts.set(22, mkBelt(22, [vTile(4, 0), vTile(4, -1)]));
      const drop = nearNub(4, 1, 0);
      grabAndHover(rig, [4, -1], [4, 0], drop);
      expect(hasRingAt(lastDockTargets(rig), nubAnchor(4, 1, 0)), 'no resting ring on the taken Fault').toBe(false);
      expect(lastNubRing(rig)).toEqual({ pt: nubAnchor(4, 1, 0), armed: false });
      releaseAt(rig, drop);
      expect(rig.sent).toHaveLength(1);
      expect([...rig.sent[0]]).toEqual([
        ...encodeGridCommand({ kind: 'Dock', belt: 22, end: 'Tail', node: 14, port: 3 }),
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // LINK-10: pressing an existing belt's end with the Belt tool armed
  // -------------------------------------------------------------------------

  it('pressing a free HEAD with the Belt tool armed draws a belt AND docks its Tail to that belt', () => {
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, upBelt());
    rig.armBelt();
    // Press the Head's DOORSTEP (4,0), the floor cell one past its end tile (3,0), which
    // is where its ring sits since 74.1. The draw seeds on the pressed cell itself,
    // exactly as a machine Out press does, and `startDock` names the BELT.
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(centre(4, 0)) });
    rig.win.fire('pointermove', { target: rig.canvas, ...atW(centre(5, 0)) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW(centre(5, 0)) });

    // Exactly one DrawBelt, over the three cells the user saw.
    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({
        kind: 'DrawBelt',
        cells: [
          [4, 0],
          [5, 0],
        ],
      }),
    ]);

    // The follow-up rides the echo: exactly one Dock, Tail end, naming the pressed
    // BELT and its Head catalog index (`Role::Out`, declared SECOND, so 1).
    // The host accepts the DrawBelt, minting belt 42 (plan 88-06, D-06).
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, mkBelt(42, [hTile(4, 0), hTile(5, 0)]));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent).toHaveLength(2);
    expect([...rig.sent[1]]).toEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Tail', node: 21, port: 1 }),
    ]);
    // And NO Dock naming a machine: there is no machine on this board at all, so the
    // second frame is the only Dock and it names belt 21.
    expect([...rig.sent[1]]).toEqual([4, 42, 1, 21, 1]);
  });

  it('a sub-cell sample inside the pressed tile does not break the draw', () => {
    // THE ONE-VARIABLE TWIN of the case above. Same board, same press, same finish
    // cell, same expected bytes. Its ONLY difference is the single extra
    // `pointermove` a quarter cell east of the pressed tile centre - the first
    // sample a real mouse emits, and the one no fixture in this repository had ever
    // produced. Every prior LINK-10 artefact teleports a whole cell per move.
    //
    // 74.1: the pressed tile is the Head's DOORSTEP (4,0), and it is the seed, so the
    // sub-cell sample is inside the seed cell and branch a ignores it. The offset is
    // derived from CELL and never from a bare 8: a quarter cell east of the centre of
    // cell 4 is 4 * 32 + 16 + 8 = 152 and `floor(152 / 32)` is 4, the PRESSED tile.
    // Nothing is asserted about the camera: the rig's shim IS the mapping, so
    // re-asserting it would test the rig.
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, upBelt());
    rig.armBelt();
    const door = centre(4, 0);
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(door) });
    // The whole experiment, in one line.
    rig.win.fire('pointermove', {
      target: rig.canvas,
      ...atW({ x: door.x + CELL / 4, y: door.y }),
    });
    rig.win.fire('pointermove', { target: rig.canvas, ...atW(centre(5, 0)) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW(centre(5, 0)) });

    // The bytes of the case above, unchanged: exactly one DrawBelt over the two
    // cells the user drew, and NOT a path that also carries the pressed belt's own
    // tile backwards.
    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({
        kind: 'DrawBelt',
        cells: [
          [4, 0],
          [5, 0],
        ],
      }),
    ]);

    // The host accepts the DrawBelt, minting belt 42 (plan 88-06, D-06).
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, mkBelt(42, [hTile(4, 0), hTile(5, 0)]));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent).toHaveLength(2);
    expect([...rig.sent[1]]).toEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Tail', node: 21, port: 1 }),
    ]);
    expect([...rig.sent[1]]).toEqual([4, 42, 1, 21, 1]);

    // THE THIRD ASSERTION, and it is the one a lazy fix would miss. Before 74-13 the
    // accumulator drove the path into SelfCrossing and `evalBeltPath` answered with
    // `showBeltPreview([], false)`, so the gesture went BLIND mid-draw. This failed
    // then independently of the two frame assertions above, and it refuses a fix that
    // drops the sample on the floor while leaving the drawn path illegal.
    expect(
      rig.overlay.beltCalls.filter((c) => c.tiles.length === 0),
      'no showBeltPreview call in the whole gesture carried an EMPTY tile list',
    ).toHaveLength(0);
  });

  it('a nub press with one sample three cells past the pressed tile leaves the pressed tile out', () => {
    // THE ONE-VARIABLE TWIN of the sub-cell case above: same board, same press, but
    // ONE sample three cells past the belt's end tile (3,0) instead of a sub-cell nudge
    // plus a teleport. Kept under its title because its subject did not change: a
    // multi-cell sample after a press on a belt's free end must not drag the pressed
    // belt's own tile into the path.
    //
    // 74.1 REWRITE. The press lands on the Head's DOORSTEP (4,0), which is the seed, so
    // the walk from the press to (6,0) is (4,0) (5,0) (6,0): (4,0) is the head and
    // branch a ignores it, (5,0) and (6,0) push. The pressed belt's tile (3,0) is not on
    // the walk at all. Before 74.1 the press sat on (3,0), one cell behind the seed, and
    // the 74-13 guard (branch c, now deleted) had to decline it.
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, upBelt());
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(centre(4, 0)) });
    rig.win.fire('pointermove', { target: rig.canvas, ...atW(centre(6, 0)) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW(centre(6, 0)) });

    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({
        kind: 'DrawBelt',
        cells: [
          [4, 0],
          [5, 0],
          [6, 0],
        ],
      }),
    ]);
    // The pressed belt's own tile is NOT in the committed path.
    const cells = rig.overlay.beltCalls.at(-1)?.tiles ?? [];
    expect(
      cells.some((t) => t.cell_x === 3 && t.cell_y === 0),
      'the pressed belt tile (3,0) never entered the drawn path',
    ).toBe(false);
    expect(
      rig.overlay.beltCalls.filter((c) => c.tiles.length === 0),
      'no showBeltPreview call in the whole gesture carried an EMPTY tile list',
    ).toHaveLength(0);
  });

  it('a doorstep press then a PERPENDICULAR drag turns at once: the corner starts on the pressed cell and docks', () => {
    // D-08 (phase 74.1): THIS CASE IS REVERSED, NOT DELETED. Its old title was `a nub
    // press then a PERPENDICULAR drag never takes the pressed tile`, and it pinned the
    // DEFECT as correct: a press on the belt's end tile (3,0) and a drag north
    // asserted the preview stayed the one-cell stub `[[4, 0]]`, which on release
    // committed a stub docked behind the hand. That is the gesture reported dead
    // on the shipped binary ("corner connecting still doesn't seem to work").
    //
    // Since 74.1 the press target is the Head's DOORSTEP (4,0), resolved by cell, and
    // the draw seeds on it. A drag NORTH from there walks (4,-1) then (4,-2), each one
    // manhattan 1 from the head, so the belt turns at once and follows the hand from the
    // first sample. It is the unit twin of the live tracer leg in
    // `e2e-live/74.1-corner-connects.live.spec.ts`.
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, upBelt()); // tiles (2,0),(3,0), Head (3,0) facing E
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(centre(4, 0)) });
    rig.win.fire('pointermove', { target: rig.canvas, ...atW(centre(4, -1)) });
    rig.win.fire('pointermove', { target: rig.canvas, ...atW(centre(4, -2)) });

    const last = rig.overlay.beltCalls.at(-1);
    expect(last?.tiles.map((t) => [t.cell_x, t.cell_y])).toEqual([
      [4, 0],
      [4, -1],
      [4, -2],
    ]);
    expect(last?.valid, 'the corner previews blue').toBe(true);
    expect(
      rig.overlay.beltCalls.some((c) => c.tiles.some((t) => t.cell_x === 3 && t.cell_y === 0)),
      'the pressed belt tile (3,0) never entered any preview',
    ).toBe(false);

    // Release: one DrawBelt over the corner, then after the echo ONE Tail dock naming
    // the pressed belt's Head (catalog index 1).
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW(centre(4, -2)) });
    expect(rig.sent).toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({
        kind: 'DrawBelt',
        cells: [
          [4, 0],
          [4, -1],
          [4, -2],
        ],
      }),
    ]);
    const echoed = route([
      [4, 0],
      [4, -1],
      [4, -2],
    ]);
    if (!echoed.ok) {
      throw new Error('fixture corner must route');
    }
    // The host accepts the DrawBelt, minting belt 42 (plan 88-06, D-06).
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, mkBelt(42, echoed.tiles));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent).toHaveLength(2);
    expect([...rig.sent[1]]).toEqual([
      ...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Tail', node: 21, port: 1 }),
    ]);
  });

  it('a draw that crosses an occupied tile still appends it and previews red', () => {
    // THE CONTROL, and it is what tells a NARROWING from a DELETION. The guard the
    // case above needs is scoped to the pressed node on the FIRST append only. A
    // guard that refused every occupied cell would fix that case and silently break
    // this one, and the OUTCOME is unchanged by 74-14 even though the mechanism now
    // needs the walk named in it: the occupied cell is refused, the head stays where
    // it was, and every cell the walk reaches beyond the refused one is then more
    // than 1 from that frozen head, so the adjacency invariant on the accumulator's
    // only push skips it too. The draw stops extending at the machine's edge and a
    // SHORTER belt than the user drew lands on release.
    //
    // This case is GREEN at HEAD and must stay green. Mutation M2 (74-13) widens the
    // guard from the pressed node to every occupied cell and exists to redden it.
    rig = setupRigWith({ cellsFromWorld: true }, node({ id: 7, cell_x: 4, cell_y: 3 }));
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(centre(2, 3)) });
    rig.win.fire('pointermove', { target: rig.canvas, ...atW(centre(3, 3)) });
    rig.win.fire('pointermove', { target: rig.canvas, ...atW(centre(4, 3)) });

    const last = rig.overlay.beltCalls.at(-1);
    expect(last?.tiles.length, 'the occupied tile is APPENDED, so the preview has geometry').toBe(3);
    expect(last?.tiles.at(-1)?.cell_x).toBe(4);
    expect(last?.valid, 'and it paints RED: this is the occupancy refusal, not a frozen draw').toBe(
      false,
    );

    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW(centre(4, 3)) });
    // Since plan 89-09 (D-13) the illegal path is sent as drawn, with no claim, so the host says
    // why; the flash is on the occupied cell.
    const frame = expectIllegalDrawSent(rig, 'the path onto the machine');
    expect([...frame], 'the three drawn cells, the occupied one included').toEqual([
      ...encodeGridCommand({
        kind: 'DrawBelt',
        cells: [
          [2, 3],
          [3, 3],
          [4, 3],
        ],
      }),
    ]);
    expect(rig.overlay.rejectFlashCalls.map((c) => c.cell), 'ONE flash, on the machine cell').toEqual([{ cx: 4, cy: 3 }]);
  });

  it('pressing the TAIL falls through to the plain cell seed and emits NO Dock', () => {
    // The role edge, and it mirrors the shipped In-nub rule one for one: a Tail is
    // `Role::In`, an In press cannot be a belt SOURCE, so it seeds at the pressed CELL
    // rather than at a facing cell and records no dock at all.
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, upBelt());
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(centre(2, 0)) });

    // OBSERVABLE, not merely "nothing was emitted": the preview's first tile is the
    // PRESSED cell (2,0). A Head press would have seeded the facing cell instead.
    const seeded = rig.overlay.beltCalls.at(-1)?.tiles ?? [];
    expect(seeded[0]?.cell_x).toBe(2);
    expect(seeded[0]?.cell_y).toBe(0);

    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW(centre(2, 0)) });
    // The seed cell is the belt's own tile, so the path is illegal and nothing is sent.
    // Whatever the release does, it emits ZERO Dock frames.
    expect(rig.sent.filter((f) => f[0] === 4)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // The target rings (74-UI-SPEC 1.2 / 3.1), and D-07's "never at rest"
  // -------------------------------------------------------------------------

  it('NOTHING is painted at rest: no ring until the Belt tool is armed (D-07)', () => {
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, upBelt());
    // A move over the board with no tool armed and nothing selected paints no targets.
    rig.win.fire('pointermove', { target: rig.canvas, ...atW(centre(3, 0)) });
    expect(rig.overlay.dockTargetCalls).toHaveLength(0);
  });

  it('arming the Belt tool rings every FREE belt Head, on its doorstep centre', () => {
    // RETITLED in 74.1 (D-04): was `..., at its end tile centre`. The ring moved one tile
    // out, onto the Head's DOORSTEP, the empty floor cell where a new belt from that end
    // begins and where the press now resolves. `up` ends at (3,0) facing E, so its ring
    // is at (4,0); the second belt runs (6,0) -> (7,0), so its ring is at (8,0).
    //
    // RE-BOARDED in 74.1-04: this case used `downBelt()` at (4,0)-(5,0), whose first tile
    // IS `up`'s doorstep, and pinned a ring there. UI-SPEC 1.3 says an occupied doorstep
    // gets no ring (a draw starting there is red and sends nothing), so the second belt
    // now sits one cell clear. The occupied case has its own named test below.
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, upBelt());
    rig.scene.belts.set(22, mkBelt(22, [hTile(6, 0), hTile(7, 0)]));
    rig.armBelt();
    expect(rig.overlay.dockTargetCalls).toHaveLength(1);
    expect(lastDockTargets(rig)).toEqual([
      { ...centre(4, 0), filled: false },
      { ...centre(8, 0), filled: false },
    ]);
    // NOT on the end tiles any more: the old anchor is gone.
    expect(lastDockTargets(rig).some((p) => p.x === centre(3, 0).x)).toBe(false);
    expect(lastDockTargets(rig).some((p) => p.x === centre(7, 0).x)).toBe(false);
    // TAILS get no ring: LINK-10's release joins the NEW belt's Tail to the pressed
    // belt's HEAD, so a ring on a Tail would offer a join the release does not make.
    // `up`'s Tail is (2,0) and its doorstep is (1,0); neither carries a ring.
    expect(lastDockTargets(rig).some((p) => p.x === centre(2, 0).x)).toBe(false);
    expect(lastDockTargets(rig).some((p) => p.x === centre(1, 0).x)).toBe(false);
  });

  it('an already-linked Head gets NO ring, and its free doorstep is a PLAIN seed: no armed ring, no Tail dock', () => {
    // REVERSED in 74.1-11 (review WR-04). Old title: `an already-linked Head gets NO
    // ring, and stays PRESSABLE anyway`. Same board, opposite outcome for half 1.
    //
    // REWRITTEN in 74.1-04 for the doorstep, in two halves (UI-SPEC 2.1 and 3.2 item 3):
    //   1. a Head docked SIDEWAYS to an In leaves its own doorstep free: no ring (headTaken).
    //      Until 74.1-11 a press there still recorded the dock and the release emitted a
    //      Tail Dock the host refused, so that whole floor tile could not start a plain
    //      belt. The press now reads `headTaken` too: the tile is an ordinary start, with
    //      no armed ring and no Dock sent;
    //   2. a Head whose doorstep holds its PARTNER is not a press target at all: the
    //      doorstep is occupied, so the press is an ordinary press on that occupant.
    // A DROP onto an already-connected end (the handle drag, manual walk step 3) is a
    // different gesture and still emits so the host answers in words; this case does
    // not touch it.
    const sinkIn = node({
      id: 9,
      kind: machine_kind.SINK,
      cell_x: 8,
      cell_y: 5,
      ports: [{ index: 0, cell_x: 8, cell_y: 5, side: 3, role: 0, medium: 0 }],
    });
    rig = setupRigWith({ cellsFromWorld: true }, sinkIn);
    // Belt 23 runs S (7,3) -> (7,5), ending on the Sink In's doorstep (7,5) arriving
    // perpendicular, Head-docked to it. Its own doorstep (7,6) is free floor.
    const routedTiles = (cells: Array<[number, number]>): TileView[] => {
      const r = route(cells);
      if (!r.ok) {
        throw new Error('fixture path must route');
      }
      return r.tiles;
    };
    rig.scene.belts.set(
      23,
      mkBelt(
        23,
        routedTiles([
          [7, 3],
          [7, 4],
          [7, 5],
        ]),
        [{ end: 'Head', node: 9, port: 0 }],
      ),
    );
    rig.scene.belts.set(22, downBelt());
    rig.armBelt();
    // Only `down`'s free Head rings, on its doorstep (6,0) (74.1); belt 23 does not.
    expect(lastDockTargets(rig)).toEqual([{ ...centre(6, 0), filled: false }]);

    // Half 1: a PLAIN seed. A press on the taken Head's DOORSTEP (7,6) seeds there, as
    // any floor press does, and acquires nothing.
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(centre(7, 6)) });
    const seeded = rig.overlay.beltCalls.at(-1)?.tiles ?? [];
    expect(seeded[0]?.cell_x).toBe(7);
    expect(seeded[0]?.cell_y).toBe(6);
    expect(rig.overlay.beltCalls.at(-1)?.valid, 'NON-VACUITY: a blue preview on the pressed cell').toBe(true);
    // The press resolved to NO source: no armed ring, and the resting set gains no fill.
    expect(rig.overlay.nubRingCalls, 'no armed ring on a taken Head\'s doorstep').toHaveLength(0);
    rig.win.fire('pointermove', { target: rig.canvas, ...atW(centre(7, 7)) });
    rig.win.fire('pointermove', { target: rig.canvas, ...atW(centre(7, 8)) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW(centre(7, 8)) });
    const drawn: Array<[number, number]> = [
      [7, 6],
      [7, 7],
      [7, 8],
    ];
    expect([...rig.sent[0]]).toEqual([...encodeGridCommand({ kind: 'DrawBelt', cells: drawn })]);
    rig.scene.belts.set(
      42,
      mkBelt(42, routedTiles(drawn)),
    );
    rig.flushRaf();
    rig.flushRaf();
    expect(
      rig.sent.filter((f) => f[0] === 4).map((f) => [...f]),
      'no Tail Dock onto the taken Head: a plain belt, and no refusal nobody asked for',
    ).toEqual([]);

    // Half 2: a Head whose doorstep holds its partner is NOT a press target.
    rig.destroy();
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, upBelt([{ end: 'Head', node: 22, port: 0 }]));
    rig.scene.belts.set(22, downBelt([{ end: 'Tail', node: 21, port: 1 }]));
    rig.armBelt();
    expect(lastDockTargets(rig)).toEqual([{ ...centre(6, 0), filled: false }]);
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(centre(4, 0)) });
    expect(rig.overlay.nubRingCalls.some((c) => c.armed), 'no source is armed on an occupied doorstep').toBe(false);
    expect(rig.overlay.beltCalls.at(-1)?.tiles[0], 'NON-VACUITY: a real preview on the pressed cell').toMatchObject({
      cell_x: 4,
      cell_y: 0,
    });
    expect(rig.overlay.beltCalls.at(-1)?.valid).toBe(false);
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW(centre(4, 0)) });
    // Since plan 89-09 (D-13) the red one-cell draw is sent, with no claim and no Tail Dock, so the
    // host says the space is taken.
    const frame = expectIllegalDrawSent(rig, 'the press on the occupied doorstep');
    expect([...frame], 'the one pressed cell').toEqual([...encodeGridCommand({ kind: 'DrawBelt', cells: [[4, 0]] })]);
  });

  it('the pressed Head is FILLED, so the user sees which end the press resolved to', () => {
    // 74.1: the ring, the press and the armed ring are all on the Head's doorstep (4,0).
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, upBelt());
    rig.armBelt();
    expect(lastDockTargets(rig)).toEqual([{ ...centre(4, 0), filled: false }]);
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(centre(4, 0)) });
    expect(lastDockTargets(rig)).toEqual([{ ...centre(4, 0), filled: true }]);
    // The armed ring is concentric with the resting one.
    expect(rig.overlay.nubRingCalls.at(-1)).toEqual({ pt: centre(4, 0), armed: true });
  });

  it('a board whose every belt Head is linked arms cleanly and rings NOTHING', () => {
    // 74-UI-SPEC 1.2 empty case: "no join is available here" is legible precisely
    // because no ring appears.
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, upBelt([{ end: 'Head', node: 22, port: 0 }]));
    rig.scene.belts.set(22, mkBelt(22, [hTile(4, 0)], [{ end: 'Tail', node: 21, port: 1 }]));
    expect(() => rig!.armBelt()).not.toThrow();
    expect(rig.cursor()).toBe('crosshair');
    // Belt 22 is SINGLE-TILE: it has an end cell but no inherent direction, which is
    // the host's own reason for refusing it as a target, so it is absent rather than
    // ringed at a fabricated side.
    expect(lastDockTargets(rig)).toEqual([]);
  });

  it('disarming the Belt tool clears the rings (D-07: they die with the tool)', () => {
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, upBelt());
    rig.armBelt();
    expect(rig.overlay.dockTargetsCleared.count).toBe(0);
    rig.armBelt(); // re-click toggle = disarm
    expect(rig.overlay.dockTargetsCleared.count).toBeGreaterThan(0);
  });

  it('a drag rings every target a drop would JOIN, INCLUDING machine ports, and never the dragged belt', () => {
    // 74-UI-SPEC 3.1, and the machine half is on purpose: ringing belt ends alone would
    // teach the user that belt ends are a special kind of target, when the whole claim
    // of this phase is that they stopped being special.
    //
    // NAMED CHANGE (plan 74.1-25, finding N4-RING). This case read "every LEGAL target"
    // (role and medium only) and pinned a ring on a sink In at (3,4), whose doorstep (3,3)
    // is three cells from the dragged Head's tile (3,0). The carrier does not move during
    // the drag, so that ring promised a join the host then refused. The rings are now
    // exactly the targets the drop ranker accepts for the dragged end: the near sink's In
    // (doorstep (3,0), the Head's own tile) and belt 22's Tail, and NOT the far sink.
    const sinkNear = node({
      id: 8,
      kind: machine_kind.SINK,
      cell_x: 3,
      cell_y: 1,
      ports: [{ index: 0, cell_x: 3, cell_y: 1, side: 0, role: 0, medium: 0 }],
    });
    const sinkIn = node({
      id: 9,
      kind: machine_kind.SINK,
      cell_x: 3,
      cell_y: 4,
      ports: [{ index: 0, cell_x: 3, cell_y: 4, side: 0, role: 0, medium: 0 }],
    });
    const sourceOut = node({
      id: 10,
      kind: machine_kind.SOURCE,
      cell_x: 9,
      cell_y: 9,
      ports: [{ index: 0, cell_x: 9, cell_y: 9, side: 1, role: 1, medium: 0 }],
    });
    rig = setupRigWith({ cellsFromWorld: true }, sinkNear, sinkIn, sourceOut);
    rig.scene.belts.set(21, upBelt());
    rig.scene.belts.set(22, downBelt());
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(centre(2, 0)) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW(centre(2, 0)) });

    // Grab the HEAD (Role::Out): the joins are Role::In targets one step from (3,0) - the
    // near sink's In and the other belt's TAIL. The far sink's In is a legal role three
    // cells away and is NOT ringed; the Source's Out is NOT ringed, and neither is any end
    // of belt 21 itself.
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(centre(3, 0)) });
    const pts = lastDockTargets(rig);
    expect(pts).toContainEqual({ ...nubAnchor(3, 1, 0), filled: false });
    expect(pts).toContainEqual({ ...centre(4, 0), filled: false });
    expect(pts, 'the far sink In: a legal role, no join from here').not.toContainEqual({
      ...nubAnchor(3, 4, 0),
      filled: false,
    });
    expect(pts).not.toContainEqual({ ...nubAnchor(9, 9, 1), filled: false });
    expect(pts.some((p) => p.x === centre(3, 0).x && p.y === centre(3, 0).y)).toBe(false);
    expect(pts.some((p) => p.x === centre(2, 0).x && p.y === centre(2, 0).y)).toBe(false);
    expect(pts).toHaveLength(2);

    // The rings clear at the terminus.
    const before = rig.overlay.dockTargetsCleared.count;
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW(centre(4, 0)) });
    expect(rig.overlay.dockTargetsCleared.count).toBeGreaterThan(before);
  });

  it('dragging a TAIL rings the mirror set: machine Outs and Faults, and free belt HEADS, that it would join', () => {
    // NAMED CHANGE (plan 74.1-25, finding N4-RING): the Source Out at (1,4), doorstep (1,3),
    // was ringed for a Tail at (4,0) and is not any more; a Source Out whose doorstep is the
    // Tail's own tile (4,0) is, beside belt 21's Head.
    const sourceNear = node({
      id: 11,
      kind: machine_kind.SOURCE,
      cell_x: 4,
      cell_y: 1,
      ports: [{ index: 0, cell_x: 4, cell_y: 1, side: 0, role: 1, medium: 0 }],
    });
    const sourceOut = node({
      id: 10,
      kind: machine_kind.SOURCE,
      cell_x: 1,
      cell_y: 4,
      ports: [{ index: 0, cell_x: 1, cell_y: 4, side: 0, role: 1, medium: 0 }],
    });
    rig = setupRigWith({ cellsFromWorld: true }, sourceNear, sourceOut);
    rig.scene.belts.set(21, upBelt());
    rig.scene.belts.set(22, downBelt());
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(centre(4, 0)) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW(centre(4, 0)) });
    // Grab belt 22's TAIL (Role::In): the joins are Role::Out / Role::Fault one step away.
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(centre(4, 0)) });
    const pts = lastDockTargets(rig);
    expect(pts).toContainEqual({ ...nubAnchor(4, 1, 0), filled: false });
    expect(pts).toContainEqual({ ...centre(3, 0), filled: false }); // belt 21's Head
    expect(pts, 'the far Source Out: a legal role, no join from here').not.toContainEqual({
      ...nubAnchor(1, 4, 0),
      filled: false,
    });
    expect(pts).toHaveLength(2);
  });

  it('a keyframe remint clears the rings rather than leaving them on stale handles', () => {
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, upBelt());
    rig.armBelt();
    const before = rig.overlay.dockTargetsCleared.count;
    rig.clearSel();
    expect(rig.overlay.dockTargetsCleared.count).toBeGreaterThan(before);
  });

  it('the WIRE tool never takes belt ends into its hit set (T-74-22)', () => {
    // The named high-severity threat, asserted behaviourally rather than by grep.
    //
    // THE RELEASE LANDS ON A REAL ELECTRICAL In, and that is what makes the case bite.
    // The first draft released on empty floor, where the release finds no target and
    // emits nothing WHATEVER the press acquired - so the mutation that admits belt ends
    // at the 22 px wire radius survived it completely. Releasing on a legal target
    // means a `DrawWire` is emitted exactly when a source was acquired, so the emit
    // count is a direct read of whether the belt Head entered the wire hit set.
    const handler = node({
      id: 9,
      kind: machine_kind.HANDLER,
      cell_x: 3,
      cell_y: 6,
      ports: [{ index: 0, cell_x: 3, cell_y: 6, side: 0, role: 0, medium: MEDIUM_ELECTRICAL }],
    });
    rig = setupRigWith({ cellsFromWorld: true }, handler);
    rig.scene.belts.set(21, upBelt());
    rig.armWire();
    const target = nubAnchor(3, 6, 0);
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(centre(3, 0)) });
    rig.win.fire('pointermove', { target: rig.canvas, ...atW(target) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW(target) });
    // No source was acquired from the belt Head, so no wire was formed at all.
    expect(rig.sent).toHaveLength(0);
    // And the wire tool's own ring set never names a belt end either: the only
    // electrical port on this board is the Handler's In.
    const wt = rig.overlay.wireTargetCalls[rig.overlay.wireTargetCalls.length - 1] ?? [];
    expect(wt).toEqual([{ ...nubAnchor(3, 6, 0), filled: false }]);
  });

  it('T-74-22 STRUCTURALLY: no call site pairs the 22 px wire radius with belt ends', () => {
    // The behavioural case above proves the SHIPPED wire path takes no belt ends. This
    // reads the source and proves the same thing about every call site at once, so a
    // FUTURE site cannot quietly reintroduce the pairing on a path no case covers.
    //
    // It also records why the plan's own count-based check reads high: the phrase
    // `wireNubHitRadiusWorld` gained ONE occurrence in this file and it is inside the
    // prose explaining why the radius must NOT be used for belt ends. The CODE-only
    // count is unchanged at five, which is what the assertion below measures.
    const src = readFileSync(join(import.meta.dirname, 'gestures.ts'), 'utf8');
    const codeLines = src
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));
    expect(codeLines.filter((l) => l.includes('wireNubHitRadiusWorld'))).toHaveLength(5);
    // And no `nubsInRadius` call passes both the wire radius and the belt-end scan.
    for (const call of src.matchAll(/nubsInRadius\(([\s\S]*?)\);/g)) {
      const args = call[1];
      expect(
        args.includes('wireNubHitRadiusWorld') && args.includes('ports+belt-ends'),
        `nubsInRadius(${args.trim()})`,
      ).toBe(false);
    }
  });

  it('the IDLE nub hover never takes belt ends either (D-07: never at rest)', () => {
    // Reader 1 of `nubsInRadius`. It paints at REST, so admitting belt ends there would
    // put a mark on a belt end with no tool armed and nothing selected - which is the
    // one thing D-07 forbids and the reason both pixel-guard baselines can hold.
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, upBelt());
    rig.win.fire('pointermove', { target: rig.canvas, ...atW(centre(3, 0)) });
    expect(rig.overlay.nubRingCalls).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Phase 89 red-first probes (plan 89-01, D-01, D-16). Each was gated and seen red at
  // PHASE89_START, and the plan that fixed it turned it on: that plan removed the gate and the
  // red-first title suffix and changed nothing else, so the test that is green is the test that
  // was seen red. Since plan 89-09 none is gated. Each prints its
  // measured facts on `P89-` lines before it asserts. Every drag below moves in sub-cell
  // samples, never one clean cell per event.
  // ---------------------------------------------------------------------------

  it(
    'a_draw_finished_on_a_belts_first_tile_docks_to_its_tail',
    () => {
      // W248 (D-06): a draw from open floor east along row 0, finished with the hand on `down`'s
      // first tile (4,0). The drawn path stops one short of it, and the Head docks `down`'s Tail
      // (port 0, the belt's In, declared first).
      rig = setupRigWith({ cellsFromWorld: true });
      rig.scene.belts.set(22, downBelt());
      rig.armBelt();
      const y = centre(0, 0).y + 5;
      rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW({ x: centre(0, 0).x, y }) });
      for (let x = centre(0, 0).x + 6; x < centre(4, 0).x; x += 6) {
        rig.win.fire('pointermove', { target: rig.canvas, ...atW({ x, y }) });
      }
      rig.win.fire('pointermove', { target: rig.canvas, ...atW({ x: centre(4, 0).x, y }) });
      rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW({ x: centre(4, 0).x, y }) });
      const drawn = rig.sent.map((f) => [...f]);
      if (drawIds(rig).length > 0) {
        acceptDraw(rig, 42);
      }
      rig.scene.belts.set(42, mkBelt(42, [hTile(0, 0), hTile(1, 0), hTile(2, 0), hTile(3, 0)]));
      rig.flushRaf();
      rig.flushRaf();
      console.log(`P89-W248 drawn=${JSON.stringify(drawn)} docks=${JSON.stringify(rig.sent.slice(1).map((f) => [...f]))}`);
      expect(drawn, "ONE DrawBelt, stopping one short of `down`'s first tile").toEqual([
        [
          ...encodeGridCommand({
            kind: 'DrawBelt',
            cells: [
              [0, 0],
              [1, 0],
              [2, 0],
              [3, 0],
            ],
          }),
        ],
      ]);
      expect(rig.sent.slice(1).map((f) => [...f]), "ONE Head Dock naming `down`'s Tail").toEqual([
        [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Head', node: 22, port: 0 })],
      ]);
    },
  );

  /** A draw from open floor east along row 0, released with the hand at world x `endX`. */
  const p89DrawEastTo = (r: Rig, endX: number): void => {
    const y = centre(0, 0).y + 5;
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...atW({ x: centre(0, 0).x, y }) });
    for (let x = centre(0, 0).x + 6; x < endX; x += 6) {
      r.win.fire('pointermove', { target: r.canvas, ...atW({ x, y }) });
    }
    r.win.fire('pointermove', { target: r.canvas, ...atW({ x: endX, y }) });
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...atW({ x: endX, y }) });
  };
  const p89Short: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
  ];

  it('a_release_beside_a_belt_start_it_does_not_face_sends_no_dock_at_low_zoom', () => {
    // Review WR-B-02: at camera scale 0.5 the release reach is 24 world px, so it reaches into the
    // cell beside a belt's first tile. Belt 21 runs East over (3,1) to (5,1). A draw West along
    // row 2 from (6,2), released in (3,2) 3 px below its top edge (19 world px from belt 21's
    // start, inside the reach) with its Head flowing West, does not face that start. D-04 rule 3
    // ("the nearest non-accepting hit, so the host refuses it in words") is for an aimed join, and
    // a belt start only counts as aimed when the hand is on its end tile: so ONE DrawBelt, no Head
    // Dock, no flash. Red before the fix: a Head Dock to belt 21 and a flash on its tile.
    const scale = 0.5;
    rig = setupRigWith({ cellsFromWorld: true, scale });
    rig.scene.belts.set(21, mkBelt(21, [hTile(3, 1), hTile(4, 1), hTile(5, 1)]));
    rig.armBelt();
    const sc = (p: Pt): Pt => ({ x: p.x * scale, y: p.y * scale });
    const y = 2 * CELL + 3;
    const startX = centre(6, 2).x - 2;
    const endX = centre(3, 2).x;
    expect(Math.hypot(endX - centre(3, 1).x, y - centre(3, 1).y), 'NON-VACUITY: inside the 24 px reach').toBeLessThan(24);
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(sc({ x: startX, y: y + 10 })) });
    for (let x = startX - 6; x > endX; x -= 6) {
      rig.win.fire('pointermove', { target: rig.canvas, ...atW(sc({ x, y: y + 10 - ((startX - x) / (startX - endX)) * 10 })) });
    }
    rig.win.fire('pointermove', { target: rig.canvas, ...atW(sc({ x: endX, y })) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW(sc({ x: endX, y })) });
    expect(rig.sent.map((f) => [...f]), 'ONE DrawBelt, as drawn').toEqual([
      [
        ...encodeGridCommand({
          kind: 'DrawBelt',
          cells: [
            [6, 2],
            [5, 2],
            [4, 2],
            [3, 2],
          ],
        }),
      ],
    ]);
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, mkBelt(42, [hTile(6, 2), hTile(5, 2), hTile(4, 2), hTile(3, 2)]));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent.slice(1).map((f) => [...f]), 'no Head Dock to a belt start the user never aimed at').toEqual([]);
    expect(rig.overlay.rejectFlashCalls, 'no flash').toHaveLength(0);
  });

  it('an_aimed_release_on_a_belt_starts_own_tile_still_joins_it_at_low_zoom', () => {
    // WR-B-02's NON-VACUITY: belt starts still count for an aimed join. The same board at scale 0.5,
    // a draw North up column 3 from (3,4), released with the hand inside belt 21's first tile
    // (3,1): the Head joins belt 21's start (rule 1, an accepting aimed hit), ONE Head Dock.
    const scale = 0.5;
    rig = setupRigWith({ cellsFromWorld: true, scale });
    rig.scene.belts.set(21, mkBelt(21, [hTile(3, 1), hTile(4, 1), hTile(5, 1)]));
    rig.armBelt();
    const sc = (p: Pt): Pt => ({ x: p.x * scale, y: p.y * scale });
    const x = centre(3, 4).x + 3;
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(sc({ x, y: centre(3, 4).y })) });
    for (let y = centre(3, 4).y - 6; y > centre(3, 1).y; y -= 6) {
      rig.win.fire('pointermove', { target: rig.canvas, ...atW(sc({ x, y })) });
    }
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW(sc({ x, y: centre(3, 1).y + 4 })) });
    expect(drawIds(rig).length, 'NON-VACUITY: the DrawBelt went out').toBeGreaterThan(0);
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, mkBelt(42, [hTile(3, 4), hTile(3, 3), hTile(3, 2)]));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent.slice(1).map((f) => [...f]), "ONE Head Dock naming belt 21's start").toEqual([
      [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Head', node: 21, port: 0 })],
    ]);
  });

  it('a_draw_finished_one_cell_short_of_a_belts_start_docks_to_it', () => {
    // D-06, UI-SPEC 3.2: the same draw as the W248 probe, released one cell SHORT of `down`'s first
    // tile, in (3,0), 3 world px past its centre: outside the 12 px radius of `down`'s Tail end
    // (29 world px away), so this is the auto-dock. `down`'s Tail is free, one step past the head
    // along its travel, and faces it, so it is the ONE candidate: ONE Head Dock naming `down`.
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(22, downBelt());
    rig.armBelt();
    p89DrawEastTo(rig, centre(3, 0).x + 3);
    const preview = rig.overlay.beltCalls.at(-1);
    expect(rig.sent.map((f) => [...f]), 'ONE DrawBelt, as drawn').toEqual([
      [...encodeGridCommand({ kind: 'DrawBelt', cells: p89Short })],
    ]);
    expect(preview?.tiles.at(-1)?.kind, 'the head runs straight on into the joined belt').toEqual({
      Straight: { axis: 0 },
    });
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, mkBelt(42, p89Short.map(([x, y]) => hTile(x, y))));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent.slice(1).map((f) => [...f]), "ONE Head Dock naming `down`'s Tail").toEqual([
      [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Head', node: 22, port: 0 })],
    ]);
  });

  it('the_auto_dock_never_joins_a_belt_tail_that_holds_a_dock', () => {
    // T-89-13: the auto-dock is a join nobody aimed at, so it never makes a fan-in. `down`'s Tail
    // already holds a dock (an upstream Source, node 9): the same one-short draw sends its DrawBelt
    // and NO Dock. NON-VACUITY: the previous case is this board with the Tail free, and it docks.
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(22, downBelt([{ end: 'Tail', node: 9, port: 0 }]));
    rig.armBelt();
    p89DrawEastTo(rig, centre(3, 0).x + 3);
    expect(rig.sent.map((f) => [...f]), 'ONE DrawBelt, as drawn').toEqual([
      [...encodeGridCommand({ kind: 'DrawBelt', cells: p89Short })],
    ]);
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, mkBelt(42, p89Short.map(([x, y]) => hTile(x, y))));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent.slice(1), 'no Dock: a Tail that holds a dock is no auto-dock target').toHaveLength(0);
  });

  it(
    'a_drag_from_an_output_dot_onto_an_unselected_belt_tail_sends_one_dock',
    () => {
      // W113 (D-05): no tool armed, nothing selected. A press inside the Source's Out dot (2.5 world
      // px inside its E edge), dragged in sub-cell samples onto an undocked belt's first tile,
      // sends exactly ONE Dock {belt, Tail, node, port}, the bytes a selected-belt Tail handle drag
      // sends, and never selects the belt.
      const src = node({
        id: 1,
        kind: machine_kind.SOURCE,
        cell_x: 2,
        cell_y: 1,
        ports: [{ index: 0, cell_x: 2, cell_y: 1, side: 1, role: 1, medium: 0 }],
      });
      rig = setupRigWith({ cellsFromWorld: true }, src);
      rig.scene.belts.set(21, mkBelt(21, [hTile(3, 1), hTile(4, 1), hTile(5, 1)]));
      const nub = nubAnchor(2, 1, 1);
      const press = { x: nub.x - 2.5, y: nub.y };
      const drop = centre(3, 1);
      rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(press) });
      for (let x = press.x + 4; x < drop.x; x += 4) {
        rig.win.fire('pointermove', { target: rig.canvas, ...atW({ x, y: drop.y + 2 }) });
      }
      rig.win.fire('pointermove', { target: rig.canvas, ...atW(drop) });
      rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW(drop) });
      const docks = rig.sent.filter((f) => f[0] === 4).map((f) => [...f]);
      const beltSelections = rig.onSelectBeltCalls.filter((id) => id !== null);
      console.log(
        `P89-W113 sent=${JSON.stringify(rig.sent.map((f) => [...f]))} select_calls=${JSON.stringify(rig.onSelectCalls)} belt_select_calls=${JSON.stringify(rig.onSelectBeltCalls)}`,
      );
      expect(docks, 'ONE Dock: the belt Tail onto the Source Out').toEqual([
        [...encodeGridCommand({ kind: 'Dock', belt: 21, end: 'Tail', node: 1, port: 0 })],
      ]);
      expect(beltSelections, 'the belt was never selected').toEqual([]);
    },
  );
  // ---------------------------------------------------------------------------
  // Phase 89, plan 89-06 (D-05, BELT-04, UI-SPEC 3.1, A11 to A14): the output-dot drag and the
  // unselected end-tile grab, beside the W113 probe above. One board throughout: a Source at
  // (2,1) whose Mechanical Out faces E onto (3,1), and belt 21 on (3,1)..(5,1), loose, its Tail
  // on that doorstep. Every drag moves in sub-cell samples.
  // ---------------------------------------------------------------------------

  const p89Source = (medium = 0): NodeView =>
    node({
      id: 1,
      kind: machine_kind.SOURCE,
      cell_x: 2,
      cell_y: 1,
      ports: [{ index: 0, cell_x: 2, cell_y: 1, side: 1, role: 1, medium }],
    });
  const p89Board = (medium = 0): Rig => {
    const r = setupRigWith({ cellsFromWorld: true }, p89Source(medium));
    r.scene.belts.set(21, mkBelt(21, [hTile(3, 1), hTile(4, 1), hTile(5, 1)]));
    return r;
  };
  /** The press on the Source's Out dot: 2.5 world px inside its E edge, as the probe presses. */
  const p89Dot = (): Pt => {
    const nub = nubAnchor(2, 1, 1);
    return { x: nub.x - 2.5, y: nub.y };
  };
  /** Press at `from`, move in 4 px samples via `via` to `to`, and leave the button down. */
  const p89DragTo = (r: Rig, from: Pt, via: Pt, to: Pt): void => {
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...atW(from) });
    for (const [a, b] of [
      [from, via],
      [via, to],
    ] as const) {
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4));
      for (let i = 1; i <= n; i += 1) {
        r.win.fire('pointermove', { target: r.canvas, ...atW({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }) });
      }
    }
  };
  const p89Up = (r: Rig, at: Pt): void => {
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...atW(at) });
  };

  it('a_click_on_an_output_dot_still_selects_the_machine', () => {
    // UI-SPEC A11, T-89-17: a press inside the dot's radius, a wobble that stays inside it, and a
    // release there is the shipped select of the machine, with nothing sent and no drag marks.
    rig = p89Board();
    const dot = p89Dot();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(dot) });
    rig.win.fire('pointermove', { target: rig.canvas, ...atW({ x: dot.x + 3, y: dot.y + 2 }) });
    p89Up(rig, { x: dot.x + 3, y: dot.y + 2 });
    expect(rig.onSelectCalls.at(-1), 'the click selected the Source').toBe(1);
    expect(rig.onSelectBeltCalls.at(-1), 'and no belt').toBeNull();
    expect(rig.sent, 'a click sends nothing').toHaveLength(0);
    expect(rig.overlay.draggedHandleCalls, 'no dragged handle: no drag started').toHaveLength(0);
    expect(rig.overlay.rejectFlashCalls, 'no flash').toHaveLength(0);
  });

  it('an_output_dot_drag_released_on_nothing_flashes_and_sends_nothing', () => {
    // UI-SPEC 3.1 "Release on nothing": the reject flash on the release cell, nothing sent, and the
    // selection never touched (no select call at all).
    rig = p89Board();
    const floor = centre(2, 5);
    p89DragTo(rig, p89Dot(), centre(4, 4), floor);
    expect(rig.overlay.draggedHandleCalls.length, 'NON-VACUITY: the drag started').toBeGreaterThan(0);
    expect(rig.cursor(), 'cursor grabbing mid-drag').toBe('grabbing');
    p89Up(rig, floor);
    expect(rig.sent, 'nothing sent').toHaveLength(0);
    expect(rig.overlay.rejectFlashCalls.map((c) => c.cell), 'ONE flash, on the release cell').toEqual([{ cx: 2, cy: 5 }]);
    expect(rig.onSelectCalls, 'the selection was never touched').toEqual([]);
    expect(rig.onSelectBeltCalls).toEqual([]);
    expect(rig.cursor(), 'the grabbing cursor went with the drag').toBe('');
    expect(rig.panState.enabled, 'pan is back').toBe(true);
  });

  it('escape_and_right_button_cancel_an_output_dot_drag', () => {
    // UI-SPEC A14: Escape, then (on a fresh drag) the right button, each mid-drag over the belt's
    // first tile: nothing sent on the release that follows, the handle and the rings cleared, no
    // flash, no select.
    //
    // REVIEW CR-B-01: THE CHORDED SHAPE IS THE REAL ONE. A right press while the left is held
    // reaches the page as a `pointermove` whose `buttons` gains bit 2, never as a `pointerdown`
    // (Pointer Events, research Pitfall 7; the belt draw's own case tests both). The
    // `pointerdown {button: 2}` shape stays for a device that sends it; the chorded shape
    // (buttons 3, then 1 as the right lifts, then the left release) is what a mouse sends, and
    // it was red before the fix: the left release sent the Dock.
    for (const how of ['Escape', 'right button', 'chorded right button'] as const) {
      rig?.destroy();
      rig = p89Board();
      const over = centre(3, 1);
      p89DragTo(rig, p89Dot(), centre(4, 4), { x: over.x + 8, y: over.y });
      expect(rig.overlay.nubRingCalls.at(-1)?.armed, `${how}: NON-VACUITY: the belt start is the armed candidate`).toBe(true);
      const handles = rig.overlay.draggedHandleCleared.count;
      const rings = rig.overlay.dockTargetsCleared.count;
      if (how === 'Escape') {
        rig.win.fire('keydown', { key: 'Escape', preventDefault: () => {} });
      } else if (how === 'right button') {
        rig.canvas.fire('pointerdown', { button: 2, target: rig.canvas, ...atW(over) });
        rig.win.fire('pointerup', { button: 2, target: rig.canvas, ...atW(over) });
      } else {
        rig.win.fire('pointermove', { buttons: 3, target: rig.canvas, ...atW(over) });
        rig.win.fire('pointermove', { buttons: 1, target: rig.canvas, ...atW({ x: over.x + 1, y: over.y }) });
      }
      expect(rig.overlay.draggedHandleCleared.count, `${how}: the dragged handle cleared`).toBeGreaterThan(handles);
      expect(rig.overlay.dockTargetsCleared.count, `${how}: the drop rings cleared`).toBeGreaterThan(rings);
      expect(rig.cursor(), `${how}: the grabbing cursor cleared`).toBe('');
      rig.win.fire('pointermove', { target: rig.canvas, ...atW(over) });
      p89Up(rig, over);
      expect(rig.sent, `${how}: nothing sent`).toHaveLength(0);
      expect(rig.overlay.rejectFlashCalls, `${how}: no flash`).toHaveLength(0);
      expect(rig.onSelectCalls, `${how}: no select`).toEqual([]);
      expect(rig.onSelectBeltCalls, `${how}: no belt select`).toEqual([]);
    }
  });

  it('escape_before_the_drag_threshold_cancels_an_output_dot_or_end_tile_press', () => {
    // Review WR-B-05: Escape during an output-dot press or an unselected belt's end-tile press (the
    // same gestures before their drag threshold) cancels them, also with a toolbar BUTTON focused.
    // The pointer stays down, drifts out (starting what would have been the drag) onto the target
    // and lets go: nothing sent, nothing selected. Red before the fix: Escape fell through to
    // "clear the selection", the drift started the drag, and the release sent the Dock.
    const nub = nubAnchor(2, 1, 1);
    const shapes = [
      { what: 'output-dot press', press: p89Dot(), drop: { x: centre(3, 1).x + 8, y: centre(3, 1).y } },
      { what: 'end-tile press', press: { x: 3 * CELL + 26, y: CELL + CELL / 2 }, drop: { x: nub.x - 1, y: nub.y + 1 } },
    ];
    for (const focus of [null, 'BUTTON'] as const) {
      for (const sh of shapes) {
        const how = `${sh.what}${focus ? ', toolbar button focused' : ''}`;
        rig?.destroy();
        rig = p89Board();
        rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(sh.press) });
        if (focus) {
          (globalThis as unknown as { document: { activeElement: unknown } }).document = {
            activeElement: { tagName: focus, isContentEditable: false },
          };
        }
        rig.win.fire('keydown', { key: 'Escape', preventDefault: () => {} });
        delete (globalThis as unknown as { document?: unknown }).document;
        const n = Math.ceil(Math.hypot(sh.drop.x - sh.press.x, sh.drop.y - sh.press.y) / 4);
        for (let i = 1; i <= n; i += 1) {
          const t = i / n;
          rig.win.fire('pointermove', {
            target: rig.canvas,
            ...atW({ x: sh.press.x + (sh.drop.x - sh.press.x) * t, y: sh.press.y + (sh.drop.y - sh.press.y) * t + 30 * Math.sin(Math.PI * t) }),
          });
        }
        expect(rig.overlay.draggedHandleCalls, `${how}: no drag started after the Escape`).toHaveLength(0);
        p89Up(rig, sh.drop);
        expect(rig.sent, `${how}: nothing sent`).toHaveLength(0);
        expect(rig.onSelectCalls, `${how}: no select`).toEqual([]);
        expect(rig.onSelectBeltCalls, `${how}: no belt select`).toEqual([]);
      }
    }
  });

  it('a_press_on_a_neighbours_body_inside_an_output_dots_reach_selects_the_neighbour', () => {
    // Review WR-B-01: at camera scale 0.25 the dot's reach is 48 world px (1.5 cells). Machine B (a
    // port-less Sink, id 2) stands on (3,2), one cell below the Source's Out doorstep. A press on
    // B's body 21 world px from the Source's Out dot selects B, as it did before phase 89, and the
    // grab cue does not show over it. Red before the fix: the dot took the press and the release
    // selected the Source. NON-VACUITY: the press point is inside the dot's reach.
    const r = setupRigWith({ cellsFromWorld: true, scale: 0.25 }, p89Source(), node({ id: 2, kind: machine_kind.SINK, cell_x: 3, cell_y: 2, ports: [] }));
    rig = r;
    r.scene.belts.set(21, mkBelt(21, [hTile(3, 1), hTile(4, 1), hTile(5, 1)]));
    const nub = nubAnchor(2, 1, 1);
    const w = { x: 3 * CELL + 6, y: 2 * CELL + 4 };
    expect(Math.hypot(w.x - nub.x, w.y - nub.y), 'NON-VACUITY: the press is inside the dot reach').toBeLessThan(nubHitRadiusWorld(0.25));
    const sp = { x: w.x * 0.25, y: w.y * 0.25 };
    r.win.fire('pointermove', { target: r.canvas, ...atW(sp) });
    expect(r.cursor(), 'no grab cue over the neighbour body').not.toBe('pointer');
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...atW(sp) });
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...atW(sp) });
    expect(r.onSelectCalls.at(-1), 'the press selected the neighbour B').toBe(2);
    expect(r.sent, 'nothing sent').toHaveLength(0);
  });

  it('a_click_near_the_edge_of_an_output_dots_reach_with_a_little_jitter_still_selects', () => {
    // Review WR-B-04: at zoom 1 the reach is 12 world px. A press 11 px from the dot centre (inside
    // the Source, the far edge of the reach) that wobbles 2 px further out before the release is a
    // click: it selects the Source, sends nothing and flashes nothing. Red before the fix: the
    // 2 px left the reach measured from the dot centre, the drag began, and the release on the
    // Source's own cell flashed red and selected nothing.
    rig = p89Board();
    const nub = nubAnchor(2, 1, 1);
    const press = { x: nub.x - 11, y: nub.y };
    const wobble = { x: nub.x - 13, y: nub.y };
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(press) });
    rig.win.fire('pointermove', { target: rig.canvas, ...atW(wobble) });
    p89Up(rig, wobble);
    expect(rig.overlay.draggedHandleCalls, 'no drag started').toHaveLength(0);
    expect(rig.overlay.rejectFlashCalls, 'no flash').toHaveLength(0);
    expect(rig.sent, 'nothing sent').toHaveLength(0);
    expect(rig.onSelectCalls.at(-1), 'the click selected the Source').toBe(1);
  });

  it('an_output_dot_drag_still_begins_once_the_hand_travels_past_the_slop', () => {
    // WR-B-04's other half: the same press, then a real drag (well past the slop and out of the
    // reach) onto belt 21's first tile still docks it. NON-VACUITY for the case above.
    rig = p89Board();
    const nub = nubAnchor(2, 1, 1);
    const over = centre(3, 1);
    p89DragTo(rig, { x: nub.x - 11, y: nub.y }, centre(4, 4), { x: over.x + 8, y: over.y });
    p89Up(rig, { x: over.x + 8, y: over.y });
    expect(rig.sent.map((f) => [...f]), "ONE Dock: belt 21's Tail onto the Source Out").toEqual([
      [...encodeGridCommand({ kind: 'Dock', belt: 21, end: 'Tail', node: 1, port: 0 })],
    ]);
  });

  it('a_chorded_right_button_cancels_an_unselected_end_tile_drag', () => {
    // Review CR-B-01, decided on purpose for the end-tile drag (UI-SPEC 3.1: it carries "the same
    // marks" as the output-dot drag, so the same cancel): nothing selected, a press on belt 21's
    // Tail tile out of the Out dot's reach, a drag out of the tile, then the right button pressed
    // with the left held (a move with buttons 3), the right lifted, and the left released on the
    // Out dot. Nothing is sent, the handle clears, nothing is selected.
    rig = p89Board();
    const press = { x: 3 * CELL + 26, y: CELL + CELL / 2 };
    const nub = nubAnchor(2, 1, 1);
    const drop = { x: nub.x - 1, y: nub.y + 1 };
    p89DragTo(rig, press, centre(5, 4), drop);
    expect(rig.overlay.draggedHandleCalls.length, 'NON-VACUITY: the handle drag started').toBeGreaterThan(0);
    const handles = rig.overlay.draggedHandleCleared.count;
    rig.win.fire('pointermove', { buttons: 3, target: rig.canvas, ...atW(drop) });
    rig.win.fire('pointermove', { buttons: 1, target: rig.canvas, ...atW(drop) });
    expect(rig.overlay.draggedHandleCleared.count, 'the dragged handle cleared').toBeGreaterThan(handles);
    p89Up(rig, drop);
    expect(rig.sent, 'nothing sent').toHaveLength(0);
    expect(rig.onSelectCalls, 'no select').toEqual([]);
    expect(rig.onSelectBeltCalls, 'no belt select').toEqual([]);
  });

  it('an_output_dot_drag_rings_every_belt_start_it_can_take', () => {
    // UI-SPEC 3.1: the drop rings are exactly the Tail ends `dropAccepts` takes from this port, at
    // their end tile centres. Belt 21's Tail is on the Out's doorstep and flows away: ringed. Belt
    // 22's Tail is on open floor away from the Out: not ringed. Belt 21's Head and every Head: not
    // ringed (an Out takes a belt's start only).
    rig = p89Board();
    rig.scene.belts.set(22, mkBelt(22, [hTile(7, 4), hTile(8, 4)]));
    p89DragTo(rig, p89Dot(), centre(4, 4), centre(4, 5));
    const rings = rig.overlay.dockTargetCalls.at(-1) ?? [];
    expect(rings, "ONE ring: belt 21's start, at its end tile centre").toEqual([{ ...centre(3, 1), filled: false }]);
    p89Up(rig, centre(4, 5));
  });

  it('an_electrical_output_dot_is_a_body_press', () => {
    // UI-SPEC A12: the same board with the Out ELECTRICAL. The press is a body press: the drag onto
    // the belt's first tile starts nothing, sends nothing, and the release selects the Source as a
    // body press does. NON-VACUITY: the Mechanical board is the W113 probe above, which docks.
    rig = p89Board(1);
    const drop = centre(3, 1);
    p89DragTo(rig, p89Dot(), centre(4, 4), drop);
    p89Up(rig, drop);
    expect(rig.sent, 'no Dock: an Electrical output starts no drag').toHaveLength(0);
    expect(rig.overlay.draggedHandleCalls, 'no dragged handle').toHaveLength(0);
    expect(rig.onSelectCalls.at(-1), 'the release selected the Source, as a body press does').toBe(1);
  });

  it('an_unselected_belt_end_tile_dragged_onto_an_out_sends_one_dock', () => {
    // UI-SPEC 3.1 last line, WINDOWS 113 item ii: nothing selected, a press on the far half of belt
    // 21's Tail tile (out of the Out dot's reach), dragged three cells away and back onto the Out
    // dot, sends ONE Dock {21, Tail, 1, 0}, the bytes a selected belt's Tail handle sends there,
    // and selects nothing.
    rig = p89Board();
    const press = { x: 3 * CELL + 26, y: CELL + CELL / 2 };
    const nub = nubAnchor(2, 1, 1);
    const drop = { x: nub.x - 1, y: nub.y + 1 };
    p89DragTo(rig, press, centre(5, 4), drop);
    expect(rig.overlay.draggedHandleCalls.length, 'NON-VACUITY: the handle drag started').toBeGreaterThan(0);
    p89Up(rig, drop);
    expect(rig.sent.map((f) => [...f]), "ONE Dock: belt 21's Tail onto the Source Out").toEqual([
      [...encodeGridCommand({ kind: 'Dock', belt: 21, end: 'Tail', node: 1, port: 0 })],
    ]);
    expect(rig.onSelectBeltCalls.filter((id) => id !== null), 'the belt was never selected').toEqual([]);
    expect(rig.onSelectCalls, 'nor the Source').toEqual([]);
  });

  it('a_click_on_an_unselected_belt_end_tile_selects_it', () => {
    // A release inside the end tile is the shipped click: the belt is selected, nothing is sent.
    rig = p89Board();
    const press = { x: 3 * CELL + 26, y: CELL + CELL / 2 };
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(press) });
    rig.win.fire('pointermove', { target: rig.canvas, ...atW({ x: press.x - 3, y: press.y + 4 }) });
    p89Up(rig, { x: press.x - 3, y: press.y + 4 });
    expect(rig.onSelectBeltCalls.at(-1), 'the click selected belt 21').toBe(21);
    expect(rig.sent, 'nothing sent').toHaveLength(0);
    expect(rig.overlay.draggedHandleCalls, 'no drag started').toHaveLength(0);
  });

  // Plan 89-07 (D-11, the 89-06 carry-over): the interruption rules reach the no-tool drags too.
  // A cancel, or a move whose `buttons` says the left button is up, ends the output-dot drag and
  // the end-tile handle drag with nothing sent and no flash, and the release after it sends nothing.
  for (const how of ['pointercancel', 'a move with the left button up'] as const) {
    it(`a ${how} ends an output-dot drag and an end-tile drag with nothing sent`, () => {
      for (const drag of ['output dot', 'end tile'] as const) {
        rig?.destroy();
        rig = p89Board();
        const over = drag === 'output dot' ? centre(3, 1) : nubAnchor(2, 1, 1);
        const from = drag === 'output dot' ? p89Dot() : { x: 3 * CELL + 26, y: CELL + CELL / 2 };
        p89DragTo(rig, from, centre(4, 4), { x: over.x + 1, y: over.y });
        expect(rig.overlay.draggedHandleCalls.length, `${drag}: NON-VACUITY: the drag started`).toBeGreaterThan(0);
        const handles = rig.overlay.draggedHandleCleared.count;
        if (how === 'pointercancel') {
          rig.win.fire('pointercancel', { target: rig.canvas, ...atW(over) });
        } else {
          rig.win.fire('pointermove', { buttons: 0, target: rig.canvas, ...atW(over) });
        }
        expect(rig.overlay.draggedHandleCleared.count, `${drag}: the dragged handle cleared`).toBeGreaterThan(handles);
        expect(rig.cursor(), `${drag}: the grabbing cursor cleared`).toBe('');
        expect(rig.panState.enabled, `${drag}: pan is back`).toBe(true);
        p89Up(rig, over);
        expect(rig.sent, `${drag}: nothing sent`).toHaveLength(0);
        expect(rig.overlay.rejectFlashCalls, `${drag}: no flash (A15)`).toHaveLength(0);
        expect(rig.onSelectCalls, `${drag}: no select`).toEqual([]);
        expect(rig.onSelectBeltCalls, `${drag}: no belt select`).toEqual([]);
      }
    });
  }

  it('a_middle_press_and_a_second_pointer_leave_an_output_dot_drag_alone', () => {
    // UI-SPEC A14 and D-11 for the output-dot drag: a middle press and release mid-drag (the camera
    // pans) and a second pointer's down, move and up are not the drag's; the owner's release on
    // the belt's start still sends the ONE Dock.
    rig = p89Board();
    const dot = p89Dot();
    const over = centre(3, 1);
    rig.canvas.fire('pointerdown', { button: 0, pointerId: 1, target: rig.canvas, ...atW(dot) });
    for (let i = 1; i <= 8; i += 1) {
      rig.win.fire('pointermove', { pointerId: 1, target: rig.canvas, ...atW({ x: dot.x + ((over.x + 1 - dot.x) * i) / 8, y: dot.y + ((over.y - dot.y) * i) / 8 }) });
    }
    expect(rig.overlay.draggedHandleCalls.length, 'NON-VACUITY: the drag started').toBeGreaterThan(0);
    rig.canvas.fire('pointerdown', { button: 1, pointerId: 1, target: rig.canvas, ...atW(over) });
    rig.win.fire('pointerup', { button: 1, pointerId: 1, target: rig.canvas, ...atW(over) });
    rig.canvas.fire('pointerdown', { button: 0, pointerId: 2, target: rig.canvas, ...atW(centre(6, 6)) });
    rig.win.fire('pointermove', { pointerId: 2, target: rig.canvas, ...atW(centre(7, 6)) });
    rig.win.fire('pointerup', { button: 0, pointerId: 2, target: rig.canvas, ...atW(centre(7, 6)) });
    expect(rig.sent, 'neither the middle release nor the stranger sent anything').toHaveLength(0);
    rig.win.fire('pointermove', { pointerId: 1, target: rig.canvas, ...atW(over) });
    rig.win.fire('pointerup', { button: 0, pointerId: 1, target: rig.canvas, ...atW(over) });
    expect(rig.sent.map((f) => [...f]), "ONE Dock: belt 21's Tail onto the Source Out").toEqual([
      [...encodeGridCommand({ kind: 'Dock', belt: 21, end: 'Tail', node: 1, port: 0 })],
    ]);
  });

  it('escape_cancels_an_end_tile_handle_drag', () => {
    // The 89-06 carry-over: Escape mid-drag of an unselected belt's end tile ends the handle drag
    // with nothing sent and no flash; until 89-07 Escape did not touch the handle drag at all.
    rig = p89Board();
    const press = { x: 3 * CELL + 26, y: CELL + CELL / 2 };
    const nub = nubAnchor(2, 1, 1);
    const drop = { x: nub.x - 1, y: nub.y + 1 };
    p89DragTo(rig, press, centre(5, 4), drop);
    expect(rig.overlay.draggedHandleCalls.length, 'NON-VACUITY: the handle drag started').toBeGreaterThan(0);
    const handles = rig.overlay.draggedHandleCleared.count;
    rig.win.fire('keydown', { key: 'Escape', preventDefault: () => {} });
    expect(rig.overlay.draggedHandleCleared.count, 'the dragged handle cleared').toBeGreaterThan(handles);
    expect(rig.cursor(), 'the grabbing cursor cleared').toBe('');
    p89Up(rig, drop);
    expect(rig.sent, 'nothing sent').toHaveLength(0);
    expect(rig.overlay.rejectFlashCalls, 'no flash').toHaveLength(0);
  });

  it('arming_a_tool_mid_drag_ends_the_output_dot_drag', () => {
    // A tool switch mid-gesture (the 89-06 carry-over): the Belt tool armed from the keyboard while
    // an output-dot drag is in flight ends the drag, nothing sent, its handle and rings cleared.
    rig = p89Board();
    const over = centre(3, 1);
    p89DragTo(rig, p89Dot(), centre(4, 4), { x: over.x + 1, y: over.y });
    expect(rig.overlay.draggedHandleCalls.length, 'NON-VACUITY: the drag started').toBeGreaterThan(0);
    const handles = rig.overlay.draggedHandleCleared.count;
    rig.armBelt();
    expect(rig.overlay.draggedHandleCleared.count, 'the dragged handle cleared').toBeGreaterThan(handles);
    p89Up(rig, over);
    expect(rig.sent, 'nothing sent').toHaveLength(0);
    expect(rig.armedCalls.at(-1), 'the Belt tool is armed').toEqual({ kind: 'belt' });
  });

  it('hovering an output dot shows the grab cursor; an In or an Electrical output does not', () => {
    // UI-SPEC A13: cursor `pointer` beside the shipped passive dot ring on a Mechanical Out; A12:
    // an Electrical Out keeps today's hover with no cursor change.
    rig = p89Board();
    const nub = nubAnchor(2, 1, 1);
    rig.win.fire('pointermove', { target: rig.canvas, ...atW({ x: nub.x - 1, y: nub.y + 1 }) });
    expect(rig.overlay.nubRingCalls.at(-1)?.armed, 'the shipped passive dot ring').toBe(false);
    expect(rig.cursor(), 'the grab cue').toBe('pointer');
    rig.win.fire('pointermove', { target: rig.canvas, ...atW(centre(2, 6)) });
    expect(rig.cursor(), 'off the dot, the cue goes').toBe('');
    rig.destroy();
    rig = p89Board(1);
    rig.win.fire('pointermove', { target: rig.canvas, ...atW({ x: nub.x - 1, y: nub.y + 1 }) });
    expect(rig.overlay.nubRingCalls.at(-1)?.armed, 'the Electrical dot keeps its passive ring').toBe(false);
    expect(rig.cursor(), 'and no cursor change').toBe('');
  });
});

// ===========================================================================
// Phase 74.1 (CORNER-01..05): the Belt-armed press target is the DOORSTEP TILE
// ===========================================================================
//
// With the Belt tool armed, a press resolves to a port exactly when the pressed CELL is
// that port's doorstep (`doorstepCell`), for a machine Out or Fault port or a belt's free
// Head. The draw seeds on the pressed cell, so the press cell IS the seed cell, and the
// per-cell rule's branch c (the 74-13 decline of the pressed node's tile) is deleted.
//
// EVERY CASE BELOW NAMES THE MUTATION THAT REDDENS IT, and each was watched red under
// that mutation alone (the plan's mutation table, M1 to M7, in 74.1-01-SUMMARY.md).
// Every negative assertion is followed by a NON-VACUITY assertion: a real preview whose
// first tile is the expected seed, so "nothing was sent" cannot pass because nothing
// was ever drawn.
describe('the doorstep press target (74.1, CORNER-01..05)', () => {
  let rig: Rig | null = null;
  afterEach(() => {
    rig?.destroy();
    rig = null;
  });

  const centre = (cx: number, cy: number): Pt => ({ x: cx * CELL + CELL / 2, y: cy * CELL + CELL / 2 });
  const atW = (p: Pt) => ({ clientX: p.x, clientY: p.y });
  const routed = (cells: Array<[number, number]>): TileView[] => {
    const r = route(cells);
    if (!r.ok) {
      throw new Error('fixture path must route');
    }
    return r.tiles;
  };
  const mkBelt = (id: number, cells: Array<[number, number]>): BeltView => ({
    id,
    latency: 4 * cells.length,
    fill: 0,
    items: [],
    tiles: routed(cells),
    docks: [],
    ticks_per_slot: 1,
  });
  /** A belt running EAST, Head at (3,0), so its doorstep is (4,0). */
  const eastBelt = (): BeltView =>
    mkBelt(21, [
      [2, 0],
      [3, 0],
    ]);
  /** SOURCE 1x1 at (2,5), Out on its E edge: doorstep (3,5), nub at world (96.5,176). */
  const src = (): NodeView =>
    node({
      id: 1,
      kind: machine_kind.SOURCE,
      cell_x: 2,
      cell_y: 5,
      ports: [{ index: 0, cell_x: 2, cell_y: 5, side: 1, role: 1, medium: 0 }],
    });
  /** SINK 1x1 at (8,5), In on its W edge: doorstep (7,5), nub at world (255.5,176). */
  const snk = (): NodeView =>
    node({
      id: 2,
      kind: machine_kind.SINK,
      cell_x: 8,
      cell_y: 5,
      ports: [{ index: 0, cell_x: 8, cell_y: 5, side: 3, role: 0, medium: 0 }],
    });
  const press = (r: Rig, p: Pt): void => r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...atW(p) });
  const move = (r: Rig, p: Pt): void => r.win.fire('pointermove', { target: r.canvas, ...atW(p) });
  const release = (r: Rig, p: Pt): void => r.win.fire('pointerup', { button: 0, target: r.canvas, ...atW(p) });
  const lastPreview = (r: Rig) => r.overlay.beltCalls.at(-1);
  const cellsOf = (tiles: TileView[] | undefined) => (tiles ?? []).map((t) => [t.cell_x, t.cell_y]);
  /** Dock frames only: a Dock's wire discriminant is 4 (`[4, belt, end, node, port]`). */
  const dockFrames = (r: Rig) => r.sent.filter((f) => f[0] === 4).map((f) => [...f]);
  /**
   * The host accepts the last DrawBelt, if one was sent, as belt 42 (plan 88-06, D-06), echoes
   * `cells` as belt 42, and the follow-up watchers run twice. A case whose gesture sent nothing
   * gets the echo alone, which is what the host would show it.
   */
  const echo = (r: Rig, cells: Array<[number, number]>): void => {
    if (drawIds(r).length > 0) {
      acceptDraw(r, 42);
    }
    r.scene.belts.set(42, mkBelt(42, cells));
    r.flushRaf();
    r.flushRaf();
  };

  // -------------------------------------------------------------------------
  // Back-drags: red and refused (D-03 as amended 2026-10-02)
  // -------------------------------------------------------------------------
  //
  // NAMED CHANGED OUTCOME (UI-SPEC 3.2 item 5), not a regression. Before 74.1 each of
  // these gestures committed a one-cell stub docked behind the hand: branch c declined
  // the pressed thing's tile while the path was one cell long, the preview stayed blue,
  // and the release sent a DrawBelt plus a Tail Dock. MUTATION M4 (branch c restored
  // verbatim) reddens all three. Since plan 89-09 (D-13) the red path is SENT as the
  // preview painted it, with no claim and no Dock, so the host refuses it in words: still
  // nothing commits, and the frame is the red path, never the one-cell stub.

  it('back-drag: an immediate reversal over the pressed BELT previews red, is refused, and commits nothing', () => {
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, eastBelt());
    rig.armBelt();
    press(rig, centre(4, 0)); // the Head's doorstep
    move(rig, centre(3, 0)); // straight back across the belt's end tile
    move(rig, centre(2, 0));
    expect(lastPreview(rig)?.valid, 'doubling back over the pressed belt previews RED').toBe(false);
    expect(cellsOf(lastPreview(rig)?.tiles)[0], 'NON-VACUITY: a real preview, seeded on the doorstep').toEqual([4, 0]);
    const redCells = cellsOf(lastPreview(rig)?.tiles);
    release(rig, centre(2, 0));
    const frame = expectIllegalDrawSent(rig, 'the back-drag');
    expect([...frame], 'the red path as previewed, not a one-cell stub').toEqual([
      ...encodeGridCommand({ kind: 'DrawBelt', cells: redCells as Array<[number, number]> }),
    ]);
    expect(redCells.length, 'NON-VACUITY: the red path is longer than the stub').toBeGreaterThan(1);
    echo(rig, [[4, 0]]);
    expect(rig.sent.filter((f) => f[0] === 4), 'and no Dock: nothing commits').toEqual([]);
  });

  it('back-drag: an immediate reversal over the pressed MACHINE previews red, is refused, and commits nothing', () => {
    rig = setupRigWith({ cellsFromWorld: true }, src());
    rig.armBelt();
    press(rig, centre(3, 5)); // the Out's doorstep
    move(rig, centre(2, 5)); // back into the source's own cell
    move(rig, centre(1, 5));
    expect(lastPreview(rig)?.valid, 'doubling back over the pressed machine previews RED').toBe(false);
    expect(cellsOf(lastPreview(rig)?.tiles)[0], 'NON-VACUITY: a real preview, seeded on the doorstep').toEqual([3, 5]);
    const redCells = cellsOf(lastPreview(rig)?.tiles);
    release(rig, centre(1, 5));
    const frame = expectIllegalDrawSent(rig, 'the back-drag');
    expect([...frame], 'the red path as previewed, not a one-cell stub').toEqual([
      ...encodeGridCommand({ kind: 'DrawBelt', cells: redCells as Array<[number, number]> }),
    ]);
    expect(redCells.length, 'NON-VACUITY: the red path is longer than the stub').toBeGreaterThan(1);
    echo(rig, [[3, 5]]);
    expect(rig.sent.filter((f) => f[0] === 4), 'and no Dock: nothing commits').toEqual([]);
  });

  it('back-drag: forward two then back three over the pressed BELT previews red, is refused, and commits nothing', () => {
    // The retreat (branch b) pops (6,0) and (5,0) on the way back, so the path is the
    // seed alone when the hand re-enters the belt's end tile (3,0): exactly the state
    // branch c used to decline in.
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, eastBelt());
    rig.armBelt();
    press(rig, centre(4, 0));
    move(rig, centre(6, 0));
    expect(cellsOf(lastPreview(rig)?.tiles), 'NON-VACUITY: the forward leg drew').toEqual([
      [4, 0],
      [5, 0],
      [6, 0],
    ]);
    move(rig, centre(3, 0));
    expect(lastPreview(rig)?.valid, 'back over the pressed belt previews RED').toBe(false);
    expect(cellsOf(lastPreview(rig)?.tiles)[0]).toEqual([4, 0]);
    const redCells = cellsOf(lastPreview(rig)?.tiles);
    release(rig, centre(3, 0));
    const frame = expectIllegalDrawSent(rig, 'the back-drag');
    expect([...frame], 'the red path as previewed, not a one-cell stub').toEqual([
      ...encodeGridCommand({ kind: 'DrawBelt', cells: redCells as Array<[number, number]> }),
    ]);
    expect(redCells.length, 'NON-VACUITY: the red path is longer than the stub').toBeGreaterThan(1);
    echo(rig, [[4, 0]]);
    expect(rig.sent.filter((f) => f[0] === 4), 'and no Dock: nothing commits').toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The press lookup's terms (doorstepPressHit)
  // -------------------------------------------------------------------------

  it('ROLE term: a press on a free In port\'s doorstep starts the REVERSED draw, which flows into that In (D-02)', () => {
    // REWRITTEN (phase 89, plan 89-05, D-02). This case pinned the old behaviour, `a press on an
    // In port's doorstep is a plain seed` with zero Docks, which drew the belt flowing OUT of the
    // input it was started on (89-MEASURE BELT-01). Now the press resolves the In
    // (`inDoorstepPressHit`): the armed ring is painted on the doorstep and the resting ring there
    // fills, the preview runs from the hand to the doorstep, the release sends the cells
    // REVERSED and the echo sends ONE Head Dock into the pressed In (no Tail: released on floor).
    rig = setupRigWith({ cellsFromWorld: true }, snk());
    rig.armBelt();
    expect(rig.overlay.dockTargetCalls.at(-1), 'the free In doorstep wears the start ring at rest').toEqual([
      { ...centre(7, 5), filled: false },
    ]);
    press(rig, centre(7, 5));
    expect(rig.overlay.nubRingCalls.at(-1), 'the press armed the In doorstep').toEqual({ pt: centre(7, 5), armed: true });
    expect(rig.overlay.dockTargetCalls.at(-1), 'and its start ring filled').toEqual([{ ...centre(7, 5), filled: true }]);
    move(rig, centre(6, 5));
    move(rig, centre(5, 5));
    const reversed: Array<[number, number]> = [
      [5, 5],
      [6, 5],
      [7, 5],
    ];
    expect(cellsOf(lastPreview(rig)?.tiles), 'the preview is the REVERSED path: the doorstep is its Head').toEqual(reversed);
    release(rig, centre(5, 5));
    expect(rig.sent, 'NON-VACUITY: the draw committed').toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([...encodeGridCommand({ kind: 'DrawBelt', cells: reversed })]);
    echo(rig, reversed);
    expect(dockFrames(rig), 'ONE Head Dock into the pressed In').toEqual([
      [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Head', node: 2, port: 0 })],
    ]);
  });

  it('ROLE term: an Electrical In\'s doorstep and an occupied In doorstep stay PLAIN seeds (D-02 MEDIUM and OCCUPANCY)', () => {
    // The In half of the press set reads the ring set's own terms (`freeInDoorstep`): an
    // Electrical In is no belt target, and an In whose doorstep holds a belt tile is already fed.
    // A press on either is a plain seed: no ring, no armed ring, and the draw is sent as drawn.
    const wiredSink = node({
      id: 3,
      kind: machine_kind.SINK,
      cell_x: 8,
      cell_y: 9,
      ports: [{ index: 0, cell_x: 8, cell_y: 9, side: 3, role: 0, medium: MEDIUM_ELECTRICAL }],
    });
    rig = setupRigWith({ cellsFromWorld: true }, snk(), wiredSink);
    // A belt whose Tail tile sits on the Sink In's doorstep (7,5): the doorstep is occupied.
    rig.scene.belts.set(31, mkBelt(31, [
      [7, 5],
      [7, 4],
    ]));
    rig.armBelt();
    expect(rig.overlay.dockTargetCalls.at(-1), 'neither In doorstep wears a ring (31\'s free Head rings at (7,3))').toEqual([
      { ...centre(7, 3), filled: false },
    ]);
    press(rig, centre(7, 9));
    expect(rig.overlay.nubRingCalls.some((c) => c.armed), 'the Electrical In doorstep armed nothing').toBe(false);
    move(rig, centre(6, 9));
    release(rig, centre(6, 9));
    expect(rig.sent.map((f) => [...f]), 'a plain draw, sent as drawn').toEqual([
      [
        ...encodeGridCommand({
          kind: 'DrawBelt',
          cells: [
            [7, 9],
            [6, 9],
          ],
        }),
      ],
    ]);
    echo(rig, [
      [7, 9],
      [6, 9],
    ]);
    expect(dockFrames(rig), 'and no Dock at all').toEqual([]);
    press(rig, centre(7, 5));
    expect(rig.overlay.nubRingCalls.some((c) => c.armed), 'the occupied In doorstep armed nothing').toBe(false);
    expect(lastPreview(rig)?.valid, 'a press on the occupant previews red').toBe(false);
  });

  it('CELL term: a press on bare floor seeds at the pressed cell, with ports elsewhere on the board', () => {
    // MUTATION M2 (cell term removed) reddens this: every Out port would then match any
    // press, the first one scanned (the source's) would win, and the draw would seed on
    // its doorstep (3,5) instead of under the hand.
    rig = setupRigWith({ cellsFromWorld: true }, src(), snk());
    rig.armBelt();
    press(rig, centre(5, 2));
    expect(cellsOf(lastPreview(rig)?.tiles), 'the seed is the pressed cell').toEqual([[5, 2]]);
    expect(lastPreview(rig)?.valid).toBe(true);
    move(rig, centre(6, 2));
    release(rig, centre(6, 2));
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({
        kind: 'DrawBelt',
        cells: [
          [5, 2],
          [6, 2],
        ],
      }),
    ]);
    echo(rig, [
      [5, 2],
      [6, 2],
    ]);
    expect(dockFrames(rig), 'a floor press records no source').toEqual([]);
  });

  it('SCAN ORDER: a doorstep shared by a machine Out and a belt Head resolves to the machine', () => {
    // MUTATION M3 (belts scanned before nodes) reddens this. The source's Out at (2,5)
    // faces E onto (3,5); belt 30 runs NORTH (3,7) -> (3,6), so its Head's doorstep is
    // (3,5) too. Nodes are scanned first, each in Map order, first hit wins, so the
    // press records the MACHINE (node 1, port 0), never the belt (node 30, port 1).
    rig = setupRigWith({ cellsFromWorld: true }, src());
    rig.scene.belts.set(
      30,
      mkBelt(30, [
        [3, 7],
        [3, 6],
      ]),
    );
    rig.armBelt();
    press(rig, centre(3, 5));
    move(rig, centre(4, 5));
    move(rig, centre(5, 5));
    release(rig, centre(5, 5));
    const drawn: Array<[number, number]> = [
      [3, 5],
      [4, 5],
      [5, 5],
    ];
    expect([...rig.sent[0]]).toEqual([...encodeGridCommand({ kind: 'DrawBelt', cells: drawn })]);
    echo(rig, drawn);
    expect(dockFrames(rig)).toEqual([
      [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Tail', node: 1, port: 0 })],
    ]);
  });

  // -------------------------------------------------------------------------
  // Error states (UI-SPEC 3.2 items 1 and 2): ordinary presses on occupied tiles
  // -------------------------------------------------------------------------

  it('a press on a belt\'s OWN last tile (the old ring location) previews red and is sent to be refused', () => {
    // UI-SPEC 3.2 item 1, a NAMED changed outcome: before 74.1 this was the ring and a
    // join start; now it is an ordinary press on an occupied tile. Since plan 89-09 (D-13,
    // FAIL-02) the red draw is sent with no claim, so the host says the space is taken, and
    // the flash is on the pressed tile; still no Dock.
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, eastBelt());
    rig.armBelt();
    press(rig, centre(3, 0));
    move(rig, centre(3, -1));
    expect(cellsOf(lastPreview(rig)?.tiles)[0], 'NON-VACUITY: seeded on the pressed end tile').toEqual([3, 0]);
    expect(lastPreview(rig)?.valid).toBe(false);
    release(rig, centre(3, -1));
    const frame = expectIllegalDrawSent(rig, 'the press on the belt end tile');
    expect([...frame]).toEqual([
      ...encodeGridCommand({
        kind: 'DrawBelt',
        cells: [
          [3, 0],
          [3, -1],
        ],
      }),
    ]);
    expect(rig.overlay.rejectFlashCalls.map((c) => c.cell), 'ONE flash, on the pressed tile').toEqual([{ cx: 3, cy: 0 }]);
    echo(rig, [
      [3, 0],
      [3, -1],
    ]);
    expect(rig.sent.filter((f) => f[0] === 4), 'no Dock').toEqual([]);
  });

  it('a press on the MACHINE-SIDE half of an Out nub previews red and is sent to be refused (D-06, D-13)', () => {
    // UI-SPEC 3.2 item 2, resting on D-06 (judged at the manual walk). The nub is at
    // world (96.5,176); a press 1 px to its machine side is inside the old 12 px disc,
    // in the source's own cell (2,5), and is no longer a belt-draw start.
    const nub = nubAnchor(2, 5, 1);
    const p = { x: nub.x - 1, y: nub.y };
    expect(Math.floor(p.x / CELL), 'the press is in the machine cell').toBe(2);
    expect(Math.hypot(p.x - nub.x, p.y - nub.y)).toBeLessThanOrEqual(nubHitRadiusWorld(1));
    rig = setupRigWith({ cellsFromWorld: true }, src());
    rig.armBelt();
    press(rig, p);
    move(rig, centre(2, 4));
    expect(cellsOf(lastPreview(rig)?.tiles)[0], 'NON-VACUITY: seeded on the machine cell').toEqual([2, 5]);
    expect(lastPreview(rig)?.valid).toBe(false);
    release(rig, centre(2, 4));
    // Since plan 89-09 (D-13, FAIL-02, the edge press): sent with no claim, flashed on the
    // pressed machine cell, so the host says why nothing was drawn.
    const frame = expectIllegalDrawSent(rig, 'the press on the machine side of the nub');
    expect([...frame]).toEqual([
      ...encodeGridCommand({
        kind: 'DrawBelt',
        cells: [
          [2, 5],
          [2, 4],
        ],
      }),
    ]);
    expect(rig.overlay.rejectFlashCalls.map((c) => c.cell), 'ONE flash, on the pressed cell').toEqual([{ cx: 2, cy: 5 }]);
  });

  it('CORNER-03 boundary: presses 1 world px apart at the machine edge each have ONE outcome', () => {
    // For the E-facing Out at cell (2,5), x*32+32.5 = 96.5 is INSIDE the doorstep (3,5)
    // and x*32+31.5 = 95.5 is inside the machine. The same perpendicular (north) drag
    // from each: the first draws a connected corner, the second is a red refusal (sent, since plan 89-09,
    // so the host refuses it in words).
    for (const [px, connects] of [
      [2 * CELL + 32.5, true],
      [2 * CELL + 31.5, false],
    ] as Array<[number, boolean]>) {
      const r = setupRigWith({ cellsFromWorld: true }, src());
      try {
        r.armBelt();
        press(r, { x: px, y: centre(2, 5).y });
        move(r, centre(3, 4));
        move(r, centre(3, 3));
        release(r, centre(3, 3));
        if (connects) {
          const corner: Array<[number, number]> = [
            [3, 5],
            [3, 4],
            [3, 3],
          ];
          expect(r.sent, `press at x=${px} commits the corner`).toHaveLength(1);
          expect([...r.sent[0]]).toEqual([...encodeGridCommand({ kind: 'DrawBelt', cells: corner })]);
          echo(r, corner);
          expect(dockFrames(r), `press at x=${px} docks the Tail to the source`).toEqual([
            [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Tail', node: 1, port: 0 })],
          ]);
        } else {
          expect(cellsOf(r.overlay.beltCalls.at(-1)?.tiles)[0], 'NON-VACUITY: seeded on the machine').toEqual([2, 5]);
          expect(r.overlay.beltCalls.at(-1)?.valid).toBe(false);
          // Since plan 89-09 (D-13): sent to be refused, never committed with a claim or a Dock.
          expectIllegalDrawSent(r, `press at x=${px}`);
          echo(r, [
            [2, 5],
            [3, 5],
          ]);
          expect(dockFrames(r), `press at x=${px} commits no Dock`).toEqual([]);
        }
      } finally {
        r.destroy();
      }
    }
  });

  // -------------------------------------------------------------------------
  // D-14: a belt that ends SIDEWAYS in front of an input now auto-connects
  // -------------------------------------------------------------------------

  it('D-14: a plain draw ending sideways on an In doorstep emits a Head Dock naming that In', () => {
    // NAMED CHANGED OUTCOME (UI-SPEC 3.2 item 6), a consequence of the host narrowing.
    // MUTATION M5 (the `dockGeometryOk` mirror un-narrowed) reddens this: the auto-dock
    // fallback counts `dockCandidates`, which then finds zero for a perpendicular Head.
    // The draw runs SOUTH (7,3) -> (7,5) and ends on the sink's doorstep (7,5), arriving
    // perpendicular to its W-facing In. The release at the cell centre is 15.5 world px
    // from the In nub, outside its 12 px radius, so this is the fallback, not a nub drop.
    rig = setupRigWith({ cellsFromWorld: true }, snk());
    rig.armBelt();
    press(rig, centre(7, 3));
    move(rig, centre(7, 4));
    move(rig, centre(7, 5));
    release(rig, centre(7, 5));
    const drawn: Array<[number, number]> = [
      [7, 3],
      [7, 4],
      [7, 5],
    ];
    expect(rig.sent, 'NON-VACUITY: the draw committed').toHaveLength(1);
    expect([...rig.sent[0]]).toEqual([...encodeGridCommand({ kind: 'DrawBelt', cells: drawn })]);
    echo(rig, drawn);
    expect(dockFrames(rig)).toEqual([
      [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Head', node: 2, port: 0 })],
    ]);
  });

  // -------------------------------------------------------------------------
  // SEAM KIND (74.1-08): the preview bends at a docked end where the commit will
  // -------------------------------------------------------------------------
  //
  // Plan 74.1-07 made the host SHIP a 90 degree corner at a docked end that turns: the
  // render packet's tiles[0] / tiles[n-1] carry the seam kind `effective_belt_tiles`
  // derives. Until the echo lands the preview is all the hand has, so it predicts that
  // kind through `seam.ts` (held to the Rust table by `seam.bin`). Each case asserts the
  // LAST preview call's kind by literal and, beside it, the previewed cells, so a kind
  // assertion can never pass on a preview that is not the path the case drew.
  //
  // Every case title starts `SEAM KIND:` so `-t 'SEAM KIND'` selects exactly this set.

  const kinds = (r: Rig) => (lastPreview(r)?.tiles ?? []).map((t) => t.kind);
  /** A machine at (5,1) whose only port is a Fault facing S: doorstep (5,2). */
  const faultS = (): NodeView =>
    node({
      id: 3,
      kind: machine_kind.FACTORY,
      cell_x: 5,
      cell_y: 1,
      ports: [{ index: 0, cell_x: 5, cell_y: 1, side: 2, role: 2, medium: 0 }],
    });
  /** A SINK at (7,6) whose In faces N: doorstep (7,5), the SAME doorstep `snk()` has. */
  const snkN = (): NodeView =>
    node({
      id: 4,
      kind: machine_kind.SINK,
      cell_x: 7,
      cell_y: 6,
      ports: [{ index: 0, cell_x: 7, cell_y: 6, side: 0, role: 0, medium: 0 }],
    });
  /**
   * Zoom the rig's camera OUT to `k` (screen = world * k), keeping all four mappings
   * consistent. At k = 0.25 (MIN_ZOOM) the nub hit radius is 12 / 0.25 = 48 world px,
   * wider than a cell, which is the one zoom where a pointer can hit an In nub while
   * the path's head is still one cell short of its doorstep.
   */
  const zoomOut = (r: Rig, k: number): void => {
    const c = r.cam as unknown as Record<string, unknown>;
    c.screenToWorld = (sx: number, sy: number) => ({ x: sx / k, y: sy / k });
    c.worldToScreen = (wx: number, wy: number) => ({ x: wx * k, y: wy * k });
    c.screenToCell = (sx: number, sy: number) => ({
      cx: Math.floor(sx / k / CELL),
      cy: Math.floor(sy / k / CELL),
    });
    c.screenToCellFrac = (sx: number, sy: number) => ({ fx: sx / k / CELL, fy: sy / k / CELL });
  };
  const scaled = (p: Pt, k: number): Pt => ({ x: p.x * k, y: p.y * k });

  it('SEAM KIND: S1, a press on a belt Head doorstep then north at once previews the corner at tiles[0]', () => {
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, eastBelt()); // Head (3,0) travelling E, doorstep (4,0)
    rig.armBelt();
    press(rig, centre(4, 0));
    move(rig, centre(4, -1));
    expect(cellsOf(lastPreview(rig)?.tiles), 'NON-VACUITY: the path turned at once').toEqual([
      [4, 0],
      [4, -1],
    ]);
    expect(lastPreview(rig)?.valid).toBe(true);
    expect(kinds(rig)[0], 'fed E, leaving N: the corner the host ships').toEqual({
      Corner: { from: 1, to: 0 },
    });
  });

  it('SEAM KIND: S2, a Source Out facing E then south at once previews Corner{E,S}; east previews Straight{X}', () => {
    rig = setupRigWith({ cellsFromWorld: true }, src()); // Out E at (2,5), doorstep (3,5)
    rig.armBelt();
    press(rig, centre(3, 5));
    move(rig, centre(3, 6));
    expect(cellsOf(lastPreview(rig)?.tiles), 'NON-VACUITY: the path turned south').toEqual([
      [3, 5],
      [3, 6],
    ]);
    expect(kinds(rig)[0]).toEqual({ Corner: { from: 1, to: 2 } });
    release(rig, centre(3, 6));
    rig.destroy();

    // The same press, straight out: the seam agrees with the belt, so Straight on X.
    rig = setupRigWith({ cellsFromWorld: true }, src());
    rig.armBelt();
    press(rig, centre(3, 5));
    move(rig, centre(4, 5));
    expect(cellsOf(lastPreview(rig)?.tiles), 'NON-VACUITY: the path ran east').toEqual([
      [3, 5],
      [4, 5],
    ]);
    expect(kinds(rig)[0]).toEqual({ Straight: { axis: 0 } });
  });

  it('SEAM KIND: a Fault nub facing S, pressed then east, previews Corner{S,E} at tiles[0]', () => {
    rig = setupRigWith({ cellsFromWorld: true }, faultS());
    rig.armBelt();
    press(rig, centre(5, 2));
    move(rig, centre(6, 2));
    expect(cellsOf(lastPreview(rig)?.tiles), 'NON-VACUITY: seeded on the Fault doorstep').toEqual([
      [5, 2],
      [6, 2],
    ]);
    expect(kinds(rig)[0]).toEqual({ Corner: { from: 2, to: 1 } });
  });

  it("SEAM KIND: a plain draw with no source previews route()'s kinds unchanged", () => {
    rig = setupRigWith({ cellsFromWorld: true });
    rig.armBelt();
    press(rig, centre(1, 1));
    move(rig, centre(2, 1));
    move(rig, centre(2, 2));
    const drawn: Array<[number, number]> = [
      [1, 1],
      [2, 1],
      [2, 2],
    ];
    expect(cellsOf(lastPreview(rig)?.tiles), 'NON-VACUITY: the drawn L').toEqual(drawn);
    expect(lastPreview(rig)?.tiles).toEqual(routed(drawn));
  });

  it('SEAM KIND: D-14, a plain draw ending sideways on an In doorstep previews the corner into the In', () => {
    // The D-14 case's board and path: south (7,3) -> (7,5) onto the W-facing In's
    // doorstep, the last sample 15.5 world px from the In nub (outside 12), so the
    // release auto-docks through `dockCandidates` (exactly one candidate).
    rig = setupRigWith({ cellsFromWorld: true }, snk());
    rig.armBelt();
    press(rig, centre(7, 3));
    move(rig, centre(7, 4));
    move(rig, centre(7, 5));
    expect(cellsOf(lastPreview(rig)?.tiles), 'NON-VACUITY: the path ends on the doorstep').toEqual([
      [7, 3],
      [7, 4],
      [7, 5],
    ]);
    expect(kinds(rig)[2], 'travelling S, draining E into the In').toEqual({
      Corner: { from: 2, to: 1 },
    });
    expect(kinds(rig)[0], 'the undocked Tail keeps route()\'s kind').toEqual({ Straight: { axis: 1 } });
  });

  it('SEAM KIND: an In-nub hit at the pointer whose doorstep IS the head previews the corner into THAT In', () => {
    // Two In ports share the doorstep (7,5): `snk()` faces W, `snkN()` faces N. The
    // D-14 rule finds TWO candidates there and docks neither, so this corner can only
    // come from the In-hit closure the release uses: the last sample sits 2 world px
    // above snkN's nub, so the release would dock snkN with nothing appended.
    rig = setupRigWith({ cellsFromWorld: true }, snk(), snkN());
    rig.armBelt();
    press(rig, centre(5, 5));
    move(rig, centre(6, 5));
    move(rig, { x: 7 * CELL + CELL / 2, y: 6 * CELL - 2 });
    expect(cellsOf(lastPreview(rig)?.tiles), 'NON-VACUITY: the path ends on the shared doorstep').toEqual([
      [5, 5],
      [6, 5],
      [7, 5],
    ]);
    expect(kinds(rig)[2], 'travelling E, draining S into the N-facing In').toEqual({
      Corner: { from: 1, to: 2 },
    });
    // The release docks the In the preview named, and the path the preview showed.
    release(rig, { x: 7 * CELL + CELL / 2, y: 6 * CELL - 2 });
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({
        kind: 'DrawBelt',
        cells: [
          [5, 5],
          [6, 5],
          [7, 5],
        ],
      }),
    ]);
    echo(rig, [
      [5, 5],
      [6, 5],
      [7, 5],
    ]);
    expect(dockFrames(rig)).toEqual([
      [...encodeGridCommand({ kind: 'Dock', belt: 42, end: 'Head', node: 4, port: 0 })],
    ]);
  });

  it('SEAM KIND: a sample that moves no cell but reaches an In nub repaints the head corner', () => {
    // The same two-In board. At the doorstep's centre neither nub is within 12 world px
    // (both 15.5 away) and D-14 finds two candidates, so the head previews route()'s
    // kind. The next sample stays inside (7,5) and moves onto snkN's nub: no cell
    // changed, yet the release would now dock snkN, so the preview must repaint.
    rig = setupRigWith({ cellsFromWorld: true }, snk(), snkN());
    rig.armBelt();
    press(rig, centre(5, 5));
    move(rig, centre(6, 5));
    move(rig, centre(7, 5));
    expect(cellsOf(lastPreview(rig)?.tiles), 'NON-VACUITY: on the shared doorstep').toEqual([
      [5, 5],
      [6, 5],
      [7, 5],
    ]);
    expect(kinds(rig)[2], 'no In hit and two candidates: no corner yet').toEqual({
      Straight: { axis: 0 },
    });
    move(rig, { x: 7 * CELL + CELL / 2, y: 6 * CELL - 2 });
    expect(cellsOf(lastPreview(rig)?.tiles), 'the cells did not move').toEqual([
      [5, 5],
      [6, 5],
      [7, 5],
    ]);
    expect(kinds(rig)[2], 'the In hit at the pointer bends the head').toEqual({
      Corner: { from: 1, to: 2 },
    });
  });

  it('SEAM KIND: a draw one cell short of an In the release would APPEND previews the appended doorstep and its corner', () => {
    // At MIN_ZOOM the nub radius is 48 world px, so a pointer in (6,5) hits the W-facing
    // In at (8,5) while the head is (6,5), one short of the doorstep (7,5). The release
    // appends (7,5) (WR-09). REWRITTEN (phase 89, plan 89-05, research Pitfall 5): this case
    // pinned a preview WITHOUT the appended cell, so the ghost the hand saw was not the belt
    // the release sent. The preview now paints `committedDraw`'s answer, the release's own:
    // the appended doorstep, turning E into the In.
    const k = 0.25;
    rig = setupRigWith({ cellsFromWorld: true }, snk());
    zoomOut(rig, k);
    rig.armBelt();
    press(rig, scaled(centre(6, 3), k));
    move(rig, scaled(centre(6, 4), k));
    move(rig, scaled(centre(6, 5), k));
    expect(cellsOf(lastPreview(rig)?.tiles), 'the preview is the path the release sends: the doorstep appended').toEqual([
      [6, 3],
      [6, 4],
      [6, 5],
      [7, 5],
    ]);
    expect(kinds(rig)[2], 'the head-1 tile turns E toward the doorstep').toEqual({ Corner: { from: 2, to: 1 } });
    expect(kinds(rig)[3], 'the appended doorstep drains E into the In').toEqual({ Straight: { axis: 0 } });
    // The release sends exactly that path.
    release(rig, scaled(centre(6, 5), k));
    expect([...rig.sent[0]]).toEqual([
      ...encodeGridCommand({
        kind: 'DrawBelt',
        cells: [
          [6, 3],
          [6, 4],
          [6, 5],
          [7, 5],
        ],
      }),
    ]);
  });

  // -------------------------------------------------------------------------
  // PENDING SEAM (74.1-20, review WR-05): the release hands the preview's seam kinds to
  // the renderer, which draws them until the follow-up Dock echoes
  // -------------------------------------------------------------------------
  //
  // The preview clears at the release and the Dock goes out a frame or more later, so
  // the release records what the preview SHOWED against the committed cells
  // (`pendingSeams.ts`). Each case compares the record with the LAST preview call made
  // before the pointer went up, never with a recomputation, so a release that recorded
  // its own different guess cannot pass.
  //
  // Every case title starts `PENDING SEAM:` so `-t 'PENDING SEAM'` selects exactly this set.

  /** The last preview the hand saw before the release, captured before `release`. */
  const shownBeforeRelease = (r: Rig) => {
    const shown = lastPreview(r);
    if (!shown) {
      throw new Error('no preview was painted before the release');
    }
    return shown.tiles.map((x) => ({ ...x }));
  };

  it('PENDING SEAM: S1, the release records exactly the kinds the preview showed, Tail expected', () => {
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, eastBelt());
    rig.scene.tick = 40;
    rig.armBelt();
    press(rig, centre(4, 0));
    move(rig, centre(4, -1));
    const shown = shownBeforeRelease(rig);
    expect(shown[0].kind, 'NON-VACUITY: the preview showed the corner').toEqual({ Corner: { from: 1, to: 0 } });
    expect(pendingSeamsRecord(), 'nothing is recorded before the release').toBeNull();
    release(rig, centre(4, -1));
    const rec = pendingSeamsRecord();
    expect(rec?.tiles, 'the recorded tiles ARE the preview the hand saw').toEqual(shown);
    expect(rec?.cells).toEqual([
      [4, 0],
      [4, -1],
    ]);
    expect(rec?.expect).toEqual({ Tail: true, Head: false });
    expect(rec?.tick, 'the release tick').toBe(40);
    expect(rec?.ttlTicks, "the follow-up's own TTL").toBe(120);
  });

  it('PENDING SEAM: S2, a Source Out turned south at once records Corner{E,S}, exactly the preview', () => {
    rig = setupRigWith({ cellsFromWorld: true }, src());
    rig.armBelt();
    press(rig, centre(3, 5));
    move(rig, centre(3, 6));
    const shown = shownBeforeRelease(rig);
    expect(shown[0].kind, 'NON-VACUITY').toEqual({ Corner: { from: 1, to: 2 } });
    release(rig, centre(3, 6));
    expect(pendingSeamsRecord()?.tiles).toEqual(shown);
    expect(pendingSeamsRecord()?.expect).toEqual({ Tail: true, Head: false });
  });

  it('PENDING SEAM: a D-14 Head auto-dock records the previewed Head corner, Head expected', () => {
    rig = setupRigWith({ cellsFromWorld: true }, snk());
    rig.armBelt();
    press(rig, centre(7, 3));
    move(rig, centre(7, 4));
    move(rig, centre(7, 5));
    const shown = shownBeforeRelease(rig);
    expect(shown[2].kind, 'NON-VACUITY').toEqual({ Corner: { from: 2, to: 1 } });
    release(rig, centre(7, 5));
    expect(pendingSeamsRecord()?.tiles).toEqual(shown);
    expect(pendingSeamsRecord()?.expect).toEqual({ Tail: false, Head: true });
  });

  it('PENDING SEAM: a release that docks nothing records nothing, and LEAVES an earlier record on other cells (74.1-30)', () => {
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, eastBelt());
    rig.armBelt();
    press(rig, centre(4, 0));
    move(rig, centre(4, -1));
    release(rig, centre(4, -1));
    expect(pendingSeamsRecord(), 'NON-VACUITY: the S1 release recorded').not.toBeNull();
    const s1 = pendingSeamsRecord();
    // A plain draw on empty floor: no source, no In, so no dock and no record. Since plan
    // 74.1-30 a DrawBelt on OTHER cells leaves the S1 record: that belt's Dock is still
    // owed (PAUSE-SECOND-DRAW). Until then it superseded it.
    press(rig, centre(10, 10));
    move(rig, centre(11, 10));
    release(rig, centre(11, 10));
    expect(rig.sent.length, 'NON-VACUITY: the plain draw emitted its DrawBelt').toBe(2);
    expect(pendingSeamsRecords(), 'only the S1 record, untouched').toEqual([s1]);
  });

  it('PENDING SEAM: a keyframe (clearSelection) keeps the record; the DrawBelt\'s refusal ends it (D-06)', () => {
    // REWRITTEN (plan 88-06): a keyframe used to drop every record; the held belt and its
    // predicted seam now survive it and end on their own verdict.
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.belts.set(21, eastBelt());
    rig.armBelt();
    press(rig, centre(4, 0));
    move(rig, centre(4, -1));
    release(rig, centre(4, -1));
    expect(pendingSeamsRecord(), 'NON-VACUITY').not.toBeNull();
    rig.clearSel();
    expect(pendingSeamsRecord(), 'the keyframe keeps it').not.toBeNull();
    rig.refuse(drawIds(rig)[0], 'FootprintCollision');
    expect(pendingSeamsRecord(), 'the refusal ends it').toBeNull();
  });

  it('PENDING SEAM: the record outlives the follow-up sending its Dock (it dies on the echo, not the send)', () => {
    rig = setupRigWith({ cellsFromWorld: true }, src());
    rig.armBelt();
    press(rig, centre(3, 5));
    move(rig, centre(3, 6));
    release(rig, centre(3, 6));
    // The DrawBelt echoes: the follow-up watcher matches it and sends the Dock.
    // The host accepts the DrawBelt, minting belt 42 (plan 88-06, D-06).
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, {
      id: 42,
      latency: 8,
      fill: 0,
      items: [],
      tiles: routed([
        [3, 5],
        [3, 6],
      ]),
      docks: [],
      ticks_per_slot: 1,
    });
    rig.flushRaf();
    expect(dockFrames(rig), 'NON-VACUITY: the Tail Dock went out').toHaveLength(1);
    expect(pendingSeamsRecord(), 'still pending until the Dock echoes').not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // HELD PREVIEW (plan 74.1-26, walk item S1R; re-pinned by plan 74.1-30): a release that
  // SENDS a DrawBelt keeps a picture of the belt on screen until the drawn belt replaces it
  // -------------------------------------------------------------------------
  //
  // The walk saw 1 to 3 frames after every release showing neither the preview nor the
  // belt: the preview cleared at the release and the belt only exists once the DrawBelt
  // echoes. Plan 74.1-26 held the DRAG PREVIEW itself until the echo. Plan 74.1-30 moves
  // the picture to the overlay's held surface (`showHeldBelts`), one picture per committed
  // belt, so the release clears the drag preview and the held picture takes over in the
  // same call. These cases read the rig's `heldBelts.pictures`, which follows every
  // `showHeldBelts` and `clearHeldBelts` the controller makes. Every title starts
  // `HELD PREVIEW:`.
  //
  // NAMED CHANGED OUTCOMES (plan 74.1-30, defaults): a new press and
  // arming another tool no longer end an earlier belt's held picture or drop its owed
  // Docks (the 74.1-26 pins said they did); a keyframe and teardown still end every one.

  /** A plain run on empty floor, three cells east from (10,10). */
  const PLAIN: Array<[number, number]> = [
    [10, 10],
    [11, 10],
    [12, 10],
  ];
  const drawPlainRun = (r: Rig): void => {
    r.armBelt();
    press(r, centre(10, 10));
    move(r, centre(11, 10));
    move(r, centre(12, 10));
    expect(r.overlay.beltPreview.on, 'NON-VACUITY: the preview is drawn before the release').toBe(true);
    release(r, centre(12, 10));
    expect(r.sent, 'NON-VACUITY: the release sent its DrawBelt').toHaveLength(1);
  };
  /** The cells of every held picture on screen, in the order the surface was handed them. */
  const heldCells = (r: Rig) => r.overlay.heldBelts.pictures.map((p) => cellsOf(p));
  /** A docked draw from the Source Out doorstep (3,5), turning south at once. */
  const drawDocked = (r: Rig): void => {
    r.armBelt();
    press(r, centre(3, 5));
    move(r, centre(3, 6));
    release(r, centre(3, 6));
    expect(r.sent, 'NON-VACUITY: the release sent its DrawBelt').toHaveLength(1);
  };
  const DOCKED_CELLS: Array<[number, number]> = [
    [3, 5],
    [3, 6],
  ];

  it('HELD PREVIEW: a plain release clears the drag preview and holds the belt\'s picture until a packet holds the belt its accept names', () => {
    // MOVED (plan 88-06, D-06): the picture used to end on a belt with exactly its cells;
    // it now ends once its DrawBelt's accept is in and a packet holds the belt it names.
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.tick = 40;
    drawPlainRun(rig);
    expect(rig.overlay.beltPreview.on, 'the drag preview ends at the release').toBe(false);
    expect(heldCells(rig), 'the held picture shows the committed belt (S1R)').toEqual([PLAIN]);
    rig.flushRaf();
    rig.flushRaf();
    expect(heldCells(rig), 'frames with no verdict keep it').toEqual([PLAIN]);
    acceptDraw(rig, 42);
    rig.flushRaf();
    expect(heldCells(rig), 'the accept alone, with no packet holding belt 42, keeps it').toEqual([PLAIN]);
    // A belt that is NOT the one the accept named does not end it.
    rig.scene.belts.set(41, mkBelt(41, PLAIN.slice(0, 2)));
    rig.flushRaf();
    expect(heldCells(rig), 'another belt is not the minted one').toEqual([PLAIN]);
    const clearedBefore = rig.overlay.heldBelts.cleared;
    rig.scene.belts.set(42, mkBelt(42, PLAIN));
    rig.flushRaf();
    expect(heldCells(rig), 'cleared in the frame the echoed belt is in the scene').toEqual([]);
    expect(rig.overlay.heldBelts.cleared, 'exactly one clear at the echo').toBe(clearedBefore + 1);
  });

  it('HELD PREVIEW: a docked release (S2) holds the corner, and the echo clears the picture in the frame its Dock goes out', () => {
    rig = setupRigWith({ cellsFromWorld: true }, src());
    drawDocked(rig);
    expect(heldCells(rig), 'the docked release holds the picture').toEqual([DOCKED_CELLS]);
    expect(pictureKindAt(rig, 3, 5), 'with its corner').toEqual(CORNER_E_S);
    const picture = rig.overlay.heldBelts.pictures[0].map((x) => ({ ...x }));
    expect(pendingSeamsRecord()?.tiles, 'one value: the predicted seam IS the held picture').toEqual(picture);
    rig.flushRaf();
    expect(dockFrames(rig), 'no Dock before the echo').toHaveLength(0);
    // The host accepts the DrawBelt, minting belt 42 (plan 88-06, D-06).
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, mkBelt(42, DOCKED_CELLS));
    rig.flushRaf();
    expect(dockFrames(rig), 'NON-VACUITY: the Tail Dock went out at the echo').toHaveLength(1);
    expect(heldCells(rig), 'the picture cleared in the same frame').toEqual([]);
    expect(pendingSeamsRecord(), 'the predicted seam carries the corner from here').not.toBeNull();
  });

  it('HELD PREVIEW: a DrawBelt never answered clears one playing tick past ECHO_TTL_TICKS, never earlier (the lost-verdict fallback)', () => {
    // MOVED (plan 88-06, D-07): a refused DrawBelt now ends on its refusal (the HELD PICTURE
    // case below); this is the fallback for a verdict that never came, on a playing board.
    // `a_lost_belt_verdict_ends_on_playing_ticks_only` pins that a paused board's drained
    // ticks never count.
    rig = setupRigWith({ cellsFromWorld: true });
    rig.scene.tick = 40;
    drawPlainRun(rig);
    // The tick does not advance, so the hold never expires.
    for (let i = 0; i < 50; i++) {
      rig.flushRaf();
    }
    expect(heldCells(rig), 'a still tick keeps the held picture').toEqual([PLAIN]);
    rig.scene.tick = 40 + 120;
    rig.flushRaf();
    expect(heldCells(rig), 'at exactly the TTL it is still held').toEqual([PLAIN]);
    rig.scene.tick = 40 + 121;
    rig.flushRaf();
    expect(heldCells(rig), 'one tick past the TTL it clears').toEqual([]);
    // The expired entry is gone: a late accept and its packet clear nothing more.
    const cleared = rig.overlay.heldBelts.cleared;
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, mkBelt(42, PLAIN));
    rig.flushRaf();
    expect(rig.overlay.heldBelts.cleared).toBe(cleared);
  });

  it('HELD PREVIEW: a keyframe keeps the held picture until the draw\'s own verdict (D-06)', () => {
    // REWRITTEN (plan 88-06): a keyframe used to clear the held picture; it now stays until
    // the DrawBelt is answered.
    rig = setupRigWith({ cellsFromWorld: true });
    drawPlainRun(rig);
    expect(heldCells(rig), 'NON-VACUITY: held').toEqual([PLAIN]);
    rig.clearSel();
    expect(heldCells(rig), 'the keyframe keeps it').toEqual([PLAIN]);
    rig.refuse(drawIds(rig)[0], 'FootprintCollision');
    expect(heldCells(rig), 'the refusal ends it').toEqual([]);
  });

  it("HELD PREVIEW: a new press LEAVES the held picture (74.1-30): the new drag and the picture both show, and the old echo clears only the picture", () => {
    rig = setupRigWith({ cellsFromWorld: true });
    drawPlainRun(rig);
    expect(heldCells(rig), 'NON-VACUITY: held').toEqual([PLAIN]);
    press(rig, centre(20, 20));
    move(rig, centre(21, 20));
    expect(rig.overlay.beltPreview.on, "NON-VACUITY: the new drag's preview is drawn").toBe(true);
    expect(heldCells(rig), 'the press left the held picture').toEqual([PLAIN]);
    // The host accepts the DrawBelt, minting belt 42 (plan 88-06, D-06).
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, mkBelt(42, PLAIN));
    rig.flushRaf();
    expect(heldCells(rig), "the old echo clears the old belt's picture").toEqual([]);
    expect(rig.overlay.beltPreview.on, "and leaves the new drag's preview").toBe(true);
  });

  it('HELD PREVIEW: arming another tool (Wire, a machine) LEAVES the held picture and the owed Docks (74.1-30)', () => {
    for (const arm of [(r: Rig) => r.armWire(), (r: Rig) => r.begin(machine_kind.SOURCE)]) {
      rig = setupRigWith({ cellsFromWorld: true }, src());
      drawDocked(rig);
      expect(heldCells(rig), 'NON-VACUITY: held').toEqual([DOCKED_CELLS]);
      arm(rig);
      expect(heldCells(rig), 'arming another tool keeps the picture').toEqual([DOCKED_CELLS]);
      // The host accepts the DrawBelt, minting belt 42 (plan 88-06, D-06).
      acceptDraw(rig, 42);
      rig.scene.belts.set(42, mkBelt(42, DOCKED_CELLS));
      rig.flushRaf();
      expect(dockFrames(rig), 'the owed Tail Dock still goes out at the echo').toHaveLength(1);
      expect(heldCells(rig), 'and the picture clears then').toEqual([]);
      rig.destroy();
      rig = null;
    }
  });

  it('HELD PREVIEW: teardown clears the held picture', () => {
    rig = setupRigWith({ cellsFromWorld: true });
    drawPlainRun(rig);
    expect(heldCells(rig), 'NON-VACUITY: held').toEqual([PLAIN]);
    const r = rig;
    rig = null;
    r.destroy();
    expect(heldCells(r)).toEqual([]);
  });

  it('HELD PREVIEW: a pointerup with no draw in progress (a toolbar click) leaves the held picture', () => {
    rig = setupRigWith({ cellsFromWorld: true });
    drawPlainRun(rig);
    release(rig, centre(30, 30));
    expect(rig.sent, 'nothing more was sent').toHaveLength(1);
    expect(heldCells(rig), 'the picture survives a stray pointerup').toEqual([PLAIN]);
  });

  it('HELD PREVIEW: putting the Belt tool away (Escape, right-click) keeps the held picture and the owed Docks', () => {
    for (const putAway of [
      (r: Rig) => r.win.fire('keydown', { key: 'Escape', preventDefault: () => {} }),
      (r: Rig) => r.canvas.fire('pointerdown', { button: 2, target: r.canvas, ...atW(centre(20, 20)) }),
    ]) {
      rig = setupRigWith({ cellsFromWorld: true }, src());
      drawDocked(rig);
      putAway(rig);
      expect(rig.armedCalls.at(-1), 'NON-VACUITY: the Belt tool is put away').toBeNull();
      expect(heldCells(rig), 'still held').toEqual([DOCKED_CELLS]);
      // The host accepts the DrawBelt, minting belt 42 (plan 88-06, D-06).
      acceptDraw(rig, 42);
      rig.scene.belts.set(42, mkBelt(42, DOCKED_CELLS));
      rig.flushRaf();
      expect(dockFrames(rig), 'the owed Tail Dock goes out at the echo').toHaveLength(1);
      expect(heldCells(rig), 'cleared on the echo').toEqual([]);
      rig.destroy();
      rig = null;
    }
  });

  it('HELD PREVIEW: a red release is sent with no held picture and clears the preview at once', () => {
    rig = setupRigWith({ cellsFromWorld: true });
    rig.armBelt();
    press(rig, centre(10, 10));
    move(rig, centre(11, 10));
    move(rig, centre(11, 11));
    move(rig, centre(10, 11));
    move(rig, centre(10, 10));
    expect(rig.overlay.beltCalls.at(-1)?.valid, 'NON-VACUITY: the preview is red (self-crossing)').toBe(false);
    expect(rig.overlay.beltPreview.on).toBe(true);
    release(rig, centre(10, 10));
    // Since plan 89-09 (D-13): sent so the host answers RouteSelfCrossing, with no claim and no
    // held picture (UI-SPEC 6.3: no blue picture survives a predicted-illegal send).
    expectIllegalDrawSent(rig, 'the red release');
    expect(rig.overlay.beltPreview.on, 'cleared at the release, as before').toBe(false);
  });

  // -------------------------------------------------------------------------
  // HELD PICTURE (plan 74.1-30, walk item S1R, PAUSE-SECOND-DRAW): the picture of every
  // committed belt shows its corner from the release until that belt's own echo
  // -------------------------------------------------------------------------
  //
  // The walk saw a docked release draw the seam STRAIGHT on the first frame after the
  // release, and for the whole pause when paused: the release cleared the gesture's feed
  // and then repainted the held preview without it. And a single follow-up slot meant a
  // second belt drawn while paused wiped the first belt's picture and its owed Dock.
  // These cases read the PICTURE the overlay stub was last asked to plot at a cell,
  // across every belt-picture surface the stub records (`pictureKindAt`), never the
  // gesture's own state. Every title starts `HELD PICTURE:`.

  /** SOURCE 1x1 at (2,9), Out on its E edge: doorstep (3,9). A second Source for two draws. */
  const src2 = (): NodeView =>
    node({
      id: 3,
      kind: machine_kind.SOURCE,
      cell_x: 2,
      cell_y: 9,
      ports: [{ index: 0, cell_x: 2, cell_y: 9, side: 1, role: 1, medium: 0 }],
    });
  /** Fed east, leaving south: the seam a Source Out on its E edge feeds a turn south with. */
  const CORNER_E_S = { Corner: { from: 1, to: 2 } };

  /**
   * The kind the overlay stub was last asked to PLOT at `(cx, cy)`, across every
   * belt-picture surface it records, or null when nothing plotted covers the cell.
   */
  const pictureKindAt = (r: Rig, cx: number, cy: number): unknown => {
    const lists: TileView[][] = [...r.overlay.heldBelts.pictures];
    if (r.overlay.beltPreview.tiles) {
      lists.push(r.overlay.beltPreview.tiles);
    }
    for (const list of lists) {
      const t = list.find((x) => x.cell_x === cx && x.cell_y === cy);
      if (t) {
        return t.kind;
      }
    }
    return null;
  };

  /** Draw a two-cell belt from a Source Out doorstep at (3, y), turning south at once. */
  const drawFromOut = (r: Rig, y: number): void => {
    press(r, centre(3, y));
    move(r, centre(3, y + 1));
    expect(pictureKindAt(r, 3, y), 'NON-VACUITY: the drag shows the corner at the seam').toEqual(CORNER_E_S);
    release(r, centre(3, y + 1));
  };

  it('HELD PICTURE: a docked release keeps the corner at the seam in the picture, from the release on (S1R)', () => {
    rig = setupRigWith({ cellsFromWorld: true }, src());
    rig.armBelt();
    drawFromOut(rig, 5);
    expect(rig.sent, 'NON-VACUITY: the release sent its DrawBelt').toHaveLength(1);
    expect(pictureKindAt(rig, 3, 5), 'the picture after the release shows the corner, not route()\'s Straight').toEqual(
      CORNER_E_S,
    );
    rig.flushRaf();
    expect(pictureKindAt(rig, 3, 5), 'a frame with no echo keeps it').toEqual(CORNER_E_S);
  });

  it('HELD PICTURE: two docked belts drawn while paused each keep their picture, and both send their Tail Dock', () => {
    rig = setupRigWith({ cellsFromWorld: true }, src(), src2());
    rig.scene.tick = 40;
    rig.armBelt();
    drawFromOut(rig, 5);
    drawFromOut(rig, 9);
    expect(rig.sent, 'NON-VACUITY: two DrawBelts sent').toHaveLength(2);
    // Paused: the tick does not move and nothing echoes.
    rig.flushRaf();
    rig.flushRaf();
    expect(pictureKindAt(rig, 3, 5), "the first belt's picture survives the second draw").toEqual(CORNER_E_S);
    expect(pictureKindAt(rig, 3, 9), "the second belt's picture").toEqual(CORNER_E_S);
    // Resume: both DrawBelts are accepted (as 42 and 43) and echo in one frame.
    acceptDraw(rig, 42, 0);
    acceptDraw(rig, 43, 1);
    rig.scene.belts.set(42, mkBelt(42, [
      [3, 5],
      [3, 6],
    ]));
    rig.scene.belts.set(43, mkBelt(43, [
      [3, 9],
      [3, 10],
    ]));
    rig.flushRaf();
    rig.flushRaf();
    const tail = (beltId: number, nodeId: number) => [
      ...encodeGridCommand({ kind: 'Dock', belt: beltId, end: 'Tail', node: nodeId, port: 0 }),
    ];
    expect(dockFrames(rig), "BOTH belts' Tail Docks went out, each once").toEqual(
      expect.arrayContaining([tail(42, 1), tail(43, 3)]),
    );
    expect(dockFrames(rig)).toHaveLength(2);
    expect(pictureKindAt(rig, 3, 5), 'each picture clears on its own echo').toBeNull();
    expect(pictureKindAt(rig, 3, 9)).toBeNull();
  });

  /** A third Source, 1x1 at (2,13), Out on its E edge: doorstep (3,13). */
  const src3 = (): NodeView =>
    node({
      id: 4,
      kind: machine_kind.SOURCE,
      cell_x: 2,
      cell_y: 13,
      ports: [{ index: 0, cell_x: 2, cell_y: 13, side: 1, role: 1, medium: 0 }],
    });
  const cellsFrom = (y: number): Array<[number, number]> => [
    [3, y],
    [3, y + 1],
  ];

  it('HELD PICTURE: three docked draws while paused each keep their picture; echoed in any order, each sends its Dock once and clears once', () => {
    rig = setupRigWith({ cellsFromWorld: true }, src(), src2(), src3());
    rig.scene.tick = 40;
    rig.armBelt();
    drawFromOut(rig, 5);
    drawFromOut(rig, 9);
    drawFromOut(rig, 13);
    rig.flushRaf();
    expect(rig.overlay.heldBelts.pictures.map((p) => cellsOf(p)), 'three pictures').toEqual([
      cellsFrom(5),
      cellsFrom(9),
      cellsFrom(13),
    ]);
    const tail = (beltId: number, nodeId: number) => [
      ...encodeGridCommand({ kind: 'Dock', belt: beltId, end: 'Tail', node: nodeId, port: 0 }),
    ];
    // Accept and echo the middle one first, then the last, then the first.
    acceptDraw(rig, 50, 1);
    rig.scene.belts.set(50, mkBelt(50, cellsFrom(9)));
    rig.flushRaf();
    expect(dockFrames(rig), 'only the echoed belt sends').toEqual([tail(50, 3)]);
    expect(rig.overlay.heldBelts.pictures.map((p) => cellsOf(p))).toEqual([cellsFrom(5), cellsFrom(13)]);
    acceptDraw(rig, 51, 2);
    rig.scene.belts.set(51, mkBelt(51, cellsFrom(13)));
    rig.flushRaf();
    expect(dockFrames(rig)).toEqual([tail(50, 3), tail(51, 4)]);
    expect(rig.overlay.heldBelts.pictures.map((p) => cellsOf(p))).toEqual([cellsFrom(5)]);
    const clearedBefore = rig.overlay.heldBelts.cleared;
    acceptDraw(rig, 52, 0);
    rig.scene.belts.set(52, mkBelt(52, cellsFrom(5)));
    rig.flushRaf();
    rig.flushRaf();
    rig.flushRaf();
    expect(dockFrames(rig), 'each Dock exactly once').toEqual([tail(50, 3), tail(51, 4), tail(52, 1)]);
    expect(rig.overlay.heldBelts.pictures).toEqual([]);
    expect(rig.overlay.heldBelts.cleared, 'the surface emptied once, at the last echo').toBe(clearedBefore + 1);
    expect(pendingSeamsRecords(), 'each belt keeps its own predicted seam until its Dock echoes').toHaveLength(3);
  });

  it('HELD PICTURE: a refused DrawBelt ends only ITS OWN entry, at its refusal (D-06)', () => {
    // MOVED (plan 88-06, D-06): the first draw used to end at its own tick TTL, the only way
    // the client could learn it was refused; it now ends on its refusal, at once, with no
    // tick passing.
    rig = setupRigWith({ cellsFromWorld: true }, src(), src2());
    rig.armBelt();
    rig.scene.tick = 40;
    drawFromOut(rig, 5);
    rig.scene.tick = 100;
    drawFromOut(rig, 9);
    expect(pendingSeamsRecords(), 'NON-VACUITY: two predicted seams').toHaveLength(2);
    rig.refuse(drawIds(rig)[0], 'FootprintCollision');
    expect(rig.overlay.heldBelts.pictures.map((p) => cellsOf(p)), "only the first belt's entry ended").toEqual([
      cellsFrom(9),
    ]);
    expect(pendingSeamsRecords().map((r) => r.cells), "and only the first belt's predicted seam").toEqual([
      cellsFrom(9),
    ]);
    // A belt on the refused draw's cells sends nothing; the live one still sends on its accept.
    acceptDraw(rig, 43, 1);
    rig.scene.belts.set(42, mkBelt(42, cellsFrom(5)));
    rig.scene.belts.set(43, mkBelt(43, cellsFrom(9)));
    rig.flushRaf();
    rig.flushRaf();
    expect(dockFrames(rig)).toEqual([
      [...encodeGridCommand({ kind: 'Dock', belt: 43, end: 'Tail', node: 3, port: 0 })],
    ]);
  });

  it('HELD PICTURE: a keyframe keeps EVERY entry, its picture and its predicted seam; each owed Dock still goes out on its accept (D-06)', () => {
    // REWRITTEN (plan 88-06, D-06): this case pinned that a keyframe ended every entry and
    // that no owed Dock went out after it ("no Dock may target a remint", T-21-13). The
    // Docks now carry the generation their handles were read in, so the keyframe ends
    // nothing: each belt still docks on its own accept and packet.
    rig = setupRigWith({ cellsFromWorld: true }, src(), src2());
    rig.armBelt();
    drawFromOut(rig, 5);
    drawFromOut(rig, 9);
    expect(rig.overlay.heldBelts.pictures, 'NON-VACUITY: two held').toHaveLength(2);
    expect(pendingSeamsRecords(), 'NON-VACUITY: two predicted seams').toHaveLength(2);
    rig.clearSel();
    expect(rig.overlay.heldBelts.pictures, 'both pictures survive the keyframe').toHaveLength(2);
    expect(pendingSeamsRecords(), 'both predicted seams survive it').toHaveLength(2);
    acceptDraw(rig, 42, 0);
    acceptDraw(rig, 43, 1);
    rig.scene.belts.set(42, mkBelt(42, cellsFrom(5)));
    rig.scene.belts.set(43, mkBelt(43, cellsFrom(9)));
    rig.flushRaf();
    rig.flushRaf();
    const tail = (beltId: number, nodeId: number) => [
      ...encodeGridCommand({ kind: 'Dock', belt: beltId, end: 'Tail', node: nodeId, port: 0 }),
    ];
    expect(dockFrames(rig), 'each belt docks once').toEqual([tail(42, 1), tail(43, 3)]);
  });

  it('HELD PICTURE: teardown ends every entry and empties the held surface', () => {
    rig = setupRigWith({ cellsFromWorld: true }, src(), src2());
    rig.armBelt();
    drawFromOut(rig, 5);
    drawFromOut(rig, 9);
    expect(rig.overlay.heldBelts.pictures, 'NON-VACUITY: two held').toHaveLength(2);
    const r = rig;
    rig = null;
    r.destroy();
    expect(r.overlay.heldBelts.pictures).toEqual([]);
    expect(pendingSeamsRecords()).toEqual([]);
  });
});

// ===========================================================================
// Phase 74.1-04 (D-05, UI-SPEC 1.3, 2.1, 3.2 item 3): machine doorstep rings, and
// the occupied doorstep
// ===========================================================================
//
// With the Belt tool armed, a machine's Mechanical Out or Fault port wears the SAME ring
// a free belt Head wears, on its DOORSTEP (`doorstepCell`), and a doorstep that already
// holds a machine or a belt tile wears no ring and is not a press target.
//
// EVERY TERM IN THE RING SET AND THE PRESS SET IS NAMED BY THE MUTATION THAT REDDENS IT
// (the six-row table, M1 to M6, in 74.1-04-SUMMARY.md). Every negative assertion sits
// beside a NON-VACUITY one: a ring the same board DOES paint, so "no ring here" cannot
// pass because nothing was ringed anywhere.
describe('machine doorstep rings and the occupied doorstep (74.1-04, D-05)', () => {
  let rig: Rig | null = null;
  afterEach(() => {
    rig?.destroy();
    rig = null;
  });

  const centre = (cx: number, cy: number): Pt => ({ x: cx * CELL + CELL / 2, y: cy * CELL + CELL / 2 });
  const ring = (cx: number, cy: number, filled = false) => ({ ...centre(cx, cy), filled });
  const atW = (p: Pt) => ({ clientX: p.x, clientY: p.y });
  const routed = (cells: Array<[number, number]>): TileView[] => {
    const r = route(cells);
    if (!r.ok) {
      throw new Error('fixture path must route');
    }
    return r.tiles;
  };
  const mkBelt = (
    id: number,
    cells: Array<[number, number]>,
    docks: BeltView['docks'] = [],
  ): BeltView => ({
    id,
    latency: 4 * cells.length,
    fill: 0,
    items: [],
    tiles: routed(cells),
    docks,
    ticks_per_slot: 1,
  });
  /** A 1x1 SOURCE at (cx,cy) whose one Mechanical Out faces `side` (0 N, 1 E, 2 S, 3 W). */
  const source = (id: number, cx: number, cy: number, side = 1): NodeView =>
    node({
      id,
      kind: machine_kind.SOURCE,
      cell_x: cx,
      cell_y: cy,
      ports: [{ index: 0, cell_x: cx, cell_y: cy, side, role: 1, medium: MEDIUM_MECHANICAL }],
    });
  /** A 1x1 SINK at (8,5), In on its W edge: doorstep (7,5). */
  const sink = (id = 2): NodeView =>
    node({
      id,
      kind: machine_kind.SINK,
      cell_x: 8,
      cell_y: 5,
      ports: [{ index: 0, cell_x: 8, cell_y: 5, side: 3, role: 0, medium: MEDIUM_MECHANICAL }],
    });
  const press = (r: Rig, p: Pt): void => r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...atW(p) });
  const move = (r: Rig, p: Pt): void => r.win.fire('pointermove', { target: r.canvas, ...atW(p) });
  const release = (r: Rig, p: Pt): void => r.win.fire('pointerup', { button: 0, target: r.canvas, ...atW(p) });
  const lastDockTargets = (r: Rig): Array<{ x: number; y: number; filled: boolean }> =>
    r.overlay.dockTargetCalls[r.overlay.dockTargetCalls.length - 1] ?? [];
  const cellsOf = (tiles: TileView[] | undefined) => (tiles ?? []).map((t) => [t.cell_x, t.cell_y]);
  const dockFrames = (r: Rig) => r.sent.filter((f) => f[0] === 4).map((f) => [...f]);
  const ringedAt = (pts: Array<{ x: number; y: number }>, cx: number, cy: number): boolean =>
    pts.some((p) => p.x === centre(cx, cy).x && p.y === centre(cx, cy).y);

  it('D-05: a Source Out and a Factory Fault each ring on their DOORSTEP centre, not on the nub', () => {
    // The ring set is EXACT, in scan order (nodes in Map order, each port in catalog
    // order, then belts). A 3x3 Factory at (2,2): In (2,3) W, Out (4,3) E -> doorstep
    // (5,3), Fault (3,4) S -> doorstep (3,5). A 1x1 Source at (9,9), Out E -> (10,9).
    // MUTATION M1 (role skip removed from branch a) reddens this too: the Factory's In would
    // ring among the sources, in scan order, instead of last.
    const factory = node({
      id: 5,
      kind: machine_kind.FACTORY,
      cell_x: 2,
      cell_y: 2,
      w: 3,
      h: 3,
      ports: [
        { index: 0, cell_x: 2, cell_y: 3, side: 3, role: 0, medium: MEDIUM_MECHANICAL },
        { index: 1, cell_x: 4, cell_y: 3, side: 1, role: 1, medium: MEDIUM_MECHANICAL },
        { index: 2, cell_x: 3, cell_y: 4, side: 2, role: 2, medium: MEDIUM_MECHANICAL },
      ],
    });
    rig = setupRigWith({ cellsFromWorld: true }, factory, source(1, 9, 9));
    rig.armBelt();
    // Since phase 89 (D-02, branch c) the Factory's free In rings too, LAST, at its doorstep
    // (1,3): the sources first, then the Ins, the press lookup's order (UI-SPEC A10).
    expect(lastDockTargets(rig)).toEqual([ring(5, 3), ring(3, 5), ring(10, 9), ring(1, 3)]);
    // NOT on the edge nub: the Wire tool's and the handle drag's anchor stays there.
    const pts = lastDockTargets(rig);
    for (const nub of [nubAnchor(9, 9, 1), nubAnchor(3, 4, 2), nubAnchor(4, 3, 1)]) {
      expect(pts.some((p) => p.x === nub.x && p.y === nub.y), `no ring on the nub ${nub.x},${nub.y}`).toBe(false);
    }
  });

  it('an Electrical Out and an Out whose doorstep holds a belt tile each get NO ring; a free In rings LAST (D-02)', () => {
    // M2 (medium skip removed) reddens it at the Electrical Out's doorstep (13,5); M3
    // (machine occupancy removed) at Source 4's doorstep (3,8), which belt 30's Tail tile sits
    // on (no dock: occupancy alone is what withdraws it). NON-VACUITY: Source 6's free Out
    // rings at (3,12) and belt 30's free Head rings at its doorstep (3,6), on the same board.
    // REWRITTEN (phase 89, plan 89-05, D-02): this case's title used to say an In port gets NO
    // ring. The Sink's free In now wears the start ring at its doorstep (7,5), after the
    // sources, because a press there starts the reversed draw.
    const electrical = node({
      id: 3,
      kind: machine_kind.SOURCE,
      cell_x: 12,
      cell_y: 5,
      ports: [{ index: 0, cell_x: 12, cell_y: 5, side: 1, role: 1, medium: MEDIUM_ELECTRICAL }],
    });
    rig = setupRigWith({ cellsFromWorld: true }, sink(2), electrical, source(4, 2, 8), source(6, 2, 12));
    rig.scene.belts.set(
      30,
      mkBelt(30, [
        [3, 8],
        [3, 7],
      ]),
    );
    rig.armBelt();
    expect(lastDockTargets(rig)).toEqual([ring(3, 12), ring(3, 6), ring(7, 5)]);
  });

  it('a Router whose Out_0 (catalog 1) is linked by a belt on its doorstep rings Out_1 and not Out_0', () => {
    // Pitfall 4: the link key is NOT the catalog index. Router 7 at (5,5), 2x3: In at
    // catalog 0, Out_0 at catalog 1 on (6,7) E -> doorstep (7,7), Out_1 at catalog 2 on
    // (6,5) E -> doorstep (7,5). Belt 31's Tail sits on Out_0's doorstep carrying a Tail
    // dock on ROUTING KEY 0. A machine port has no separate linked term: the dock rule
    // puts the linking belt's end tile ON the doorstep, so occupancy carries the claim.
    // MUTATION M3 (machine occupancy removed) reddens this at (7,7). A linked term
    // written as `d.port === port.index` would compare key 0 with the In's index and
    // leave Out_0 ringed, which this case would also catch.
    const router = node({
      id: 7,
      kind: machine_kind.ROUTER,
      cell_x: 5,
      cell_y: 5,
      w: 2,
      h: 3,
      ports: [
        { index: 0, cell_x: 5, cell_y: 5, side: 3, role: 0, medium: MEDIUM_MECHANICAL },
        { index: 1, cell_x: 6, cell_y: 7, side: 1, role: 1, medium: MEDIUM_MECHANICAL },
        { index: 2, cell_x: 6, cell_y: 5, side: 1, role: 1, medium: MEDIUM_MECHANICAL },
      ],
    });
    rig = setupRigWith({ cellsFromWorld: true }, router);
    rig.scene.belts.set(
      31,
      mkBelt(
        31,
        [
          [7, 7],
          [8, 7],
          [9, 7],
        ],
        [{ end: 'Tail', node: 7, port: 0 }],
      ),
    );
    rig.armBelt();
    const pts = lastDockTargets(rig);
    expect(ringedAt(pts, 7, 5), 'Out_1 is free: ringed on its doorstep').toBe(true);
    expect(ringedAt(pts, 7, 7), 'Out_0 is linked: its doorstep holds the belt, no ring').toBe(false);
    // The Router's free In (catalog 0, (5,5) facing W) rings last at its doorstep (4,5) since
    // phase 89 (D-02, branch c).
    expect(pts).toEqual([ring(7, 5), ring(10, 7), ring(4, 5)]);
  });

  it('a free belt Head whose doorstep holds a MACHINE gets no ring', () => {
    // MUTATION M4 (belt occupancy removed) reddens this at (5,2). Belt 32 runs E ending at
    // (4,2), so its doorstep is (5,2), which a Source's body covers. That Source's own Out
    // faces N, so it rings at (5,1): the NON-VACUITY ring.
    rig = setupRigWith({ cellsFromWorld: true }, source(8, 5, 2, 0));
    rig.scene.belts.set(
      32,
      mkBelt(32, [
        [3, 2],
        [4, 2],
      ]),
    );
    rig.armBelt();
    expect(lastDockTargets(rig)).toEqual([ring(5, 1)]);
  });

  it('a belt Head docked SIDEWAYS to an In, with its own doorstep free, gets no ring (headTaken is not masked)', () => {
    // Since the host narrowing a Head may dock arriving perpendicular to an In and leave
    // its own doorstep empty floor, so occupancy cannot carry "already linked" for a belt
    // Head. MUTATION M5 (`headTaken` removed from the belt-armed branch) reddens this at
    // (7,6). Belt 33 runs S (7,3) -> (7,5) and ends on the Sink's In doorstep (7,5) with a
    // Head dock naming the Sink; its own doorstep (7,6) is free. NON-VACUITY: belt 34's
    // free Head rings at (3,1).
    rig = setupRigWith({ cellsFromWorld: true }, sink(2));
    rig.scene.belts.set(
      33,
      mkBelt(
        33,
        [
          [7, 3],
          [7, 4],
          [7, 5],
        ],
        [{ end: 'Head', node: 2, port: 0 }],
      ),
    );
    rig.scene.belts.set(
      34,
      mkBelt(34, [
        [1, 1],
        [2, 1],
      ]),
    );
    rig.armBelt();
    expect(lastDockTargets(rig)).toEqual([ring(3, 1)]);
  });

  it('74.1-11 MEDIUM TERM: an Electrical Out\'s free doorstep is a PLAIN seed: no ring, one DrawBelt, zero Dock frames', () => {
    // Review WR-04. The ring set skips an Electrical Out (a belt is always Mechanical),
    // and since 74.1-11 the press reads the same medium term, so the floor tile in front
    // of a wire output is an ordinary place to start a belt. Before it, the press
    // resolved the Out, painted a non-accepting armed ring, and the release queued a
    // Tail Dock the host refuses as MediumMismatch: a refusal for a dock nobody asked
    // for. MUTATION M1 (medium term removed from the press alone) reddens the ring and
    // the Dock lines. Electrical Source 3 at (12,5) faces E onto (13,5).
    const electrical = node({
      id: 3,
      kind: machine_kind.SOURCE,
      cell_x: 12,
      cell_y: 5,
      ports: [{ index: 0, cell_x: 12, cell_y: 5, side: 1, role: 1, medium: MEDIUM_ELECTRICAL }],
    });
    rig = setupRigWith({ cellsFromWorld: true }, electrical);
    rig.armBelt();
    expect(lastDockTargets(rig), 'no resting ring on the Electrical doorstep').toEqual([]);
    press(rig, centre(13, 5));
    expect(rig.overlay.nubRingCalls, 'the press resolves no source: no ring of any kind').toHaveLength(0);
    expect(cellsOf(rig.overlay.beltCalls.at(-1)?.tiles)[0], 'NON-VACUITY: a preview on the pressed cell').toEqual([13, 5]);
    expect(rig.overlay.beltCalls.at(-1)?.valid, 'and it is blue (a legal start)').toBe(true);
    move(rig, centre(14, 5));
    move(rig, centre(15, 5));
    release(rig, centre(15, 5));
    const drawn: Array<[number, number]> = [
      [13, 5],
      [14, 5],
      [15, 5],
    ];
    expect(rig.sent.map((f) => [...f]), 'exactly one DrawBelt, from the pressed cell').toEqual([
      [...encodeGridCommand({ kind: 'DrawBelt', cells: drawn })],
    ]);
    // The host accepts the DrawBelt, minting belt 42 (plan 88-06, D-06).
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, mkBelt(42, drawn));
    rig.flushRaf();
    rig.flushRaf();
    expect(dockFrames(rig), 'no Tail Dock onto the wire Out, so no refusal').toEqual([]);
  });

  it('74.1-11 HEAD-TAKEN TERM: a sideways-docked belt Head\'s free doorstep is a PLAIN seed: one DrawBelt, zero Dock frames', () => {
    // Review WR-04. Belt 33 runs N (7,7) -> (7,5) and ends on the Sink's In doorstep
    // (7,5), arriving perpendicular, Head-docked to it (D-14). Its own doorstep (7,4) is
    // free floor, so occupancy cannot carry the claim; `headTaken` does, for the ring set
    // and (since 74.1-11) the press alike. Before it, the press resolved the taken Head,
    // painted an ACCEPTING armed ring, and the release queued a Tail Dock the host
    // refuses as a taken belt end (`BeltEndTaken` since plan 74.1-32). MUTATION M2 (Head-taken term removed from the press alone)
    // reddens the ring and the Dock lines.
    rig = setupRigWith({ cellsFromWorld: true }, sink(2));
    rig.scene.belts.set(
      33,
      mkBelt(
        33,
        [
          [7, 7],
          [7, 6],
          [7, 5],
        ],
        [{ end: 'Head', node: 2, port: 0 }],
      ),
    );
    rig.armBelt();
    expect(lastDockTargets(rig), 'the taken Head wears no resting ring').toEqual([]);
    press(rig, centre(7, 4));
    expect(rig.overlay.nubRingCalls, 'the press resolves no source: no ring of any kind').toHaveLength(0);
    expect(cellsOf(rig.overlay.beltCalls.at(-1)?.tiles)[0], 'NON-VACUITY: a preview on the pressed cell').toEqual([7, 4]);
    expect(rig.overlay.beltCalls.at(-1)?.valid, 'and it is blue (a legal start)').toBe(true);
    move(rig, centre(7, 3));
    move(rig, centre(7, 2));
    release(rig, centre(7, 2));
    const drawn: Array<[number, number]> = [
      [7, 4],
      [7, 3],
      [7, 2],
    ];
    expect(rig.sent.map((f) => [...f]), 'exactly one DrawBelt, from the pressed cell').toEqual([
      [...encodeGridCommand({ kind: 'DrawBelt', cells: drawn })],
    ]);
    // The host accepts the DrawBelt, minting belt 42 (plan 88-06, D-06).
    acceptDraw(rig, 42);
    rig.scene.belts.set(42, mkBelt(42, drawn));
    rig.flushRaf();
    rig.flushRaf();
    expect(dockFrames(rig), 'no Tail Dock onto the taken Head, so no refusal').toEqual([]);
  });

  it('a press on an OCCUPIED doorstep paints no armed ring and commits nothing; a free doorstep on the same board does arm', () => {
    // Pitfall 5: without the press-side occupancy term this press STILL commits nothing (the
    // seed is occupied, so the path is red either way; since plan 89-09 the red draw is sent
    // with no claim and no Dock, so the host says why). The one signal the term moves is
    // the ARMED RING: without it `doorstepPressHit` resolves Source 1's Out and paints an
    // armed ring at (3,5). MUTATION M6 (press occupancy removed) reddens the
    // `nubRingCalls` line. Source 1 at (2,5) faces E onto (3,5), where belt 35's Tail tile
    // sits.
    rig = setupRigWith({ cellsFromWorld: true }, source(1, 2, 5), source(6, 2, 10));
    rig.scene.belts.set(
      35,
      mkBelt(35, [
        [3, 5],
        [3, 4],
      ]),
    );
    rig.armBelt();
    press(rig, centre(3, 5));
    expect(rig.overlay.nubRingCalls, 'no ring of any kind is painted by a press on an occupied doorstep').toHaveLength(0);
    for (const call of rig.overlay.dockTargetCalls) {
      expect(ringedAt(call, 3, 5), 'no resting or filled ring at the occupied doorstep').toBe(false);
    }
    expect(cellsOf(rig.overlay.beltCalls.at(-1)?.tiles)[0], 'NON-VACUITY: a real preview on the pressed cell').toEqual([3, 5]);
    expect(rig.overlay.beltCalls.at(-1)?.valid).toBe(false);
    move(rig, centre(4, 5));
    release(rig, centre(4, 5));
    expectIllegalDrawSent(rig, 'the press on the occupied doorstep');
    expect(dockFrames(rig), 'nothing commits: no Dock').toEqual([]);

    // NON-VACUITY for the press half: Source 6's FREE doorstep (3,10) on the same board
    // arms, concentric with its filled resting ring.
    press(rig, centre(3, 10));
    expect(rig.overlay.nubRingCalls.at(-1)).toEqual({ pt: centre(3, 10), armed: true });
    expect(lastDockTargets(rig)).toContainEqual(ring(3, 10, true));
  });

  // Phase 88 red-first probe (plan 88-01, BELT-06, D-09), red at PHASE88_START
  // (`sentAfterSecond=2`); plan 88-07 counts queued gestures in the client's occupancy read and
  // turns it on, its body unchanged.
  it(
    'a_held_belt_occupies_its_doorstep [red-first: BELT-06; plan 88-07 turns this on]',
    () => {
      // A paused board. The user draws a belt from Source 1's Out doorstep (3,5) east to
      // (5,5): one DrawBelt goes out and waits, unfolded, for Play. Then a second drag from the
      // same doorstep, south: the host would refuse it on Play (the first belt holds (3,5)), so
      // the preview must read red. Since plan 89-09 (D-13) the red draw is sent with no claim, so
      // the host refuses it in words on Play, where until then nothing was sent.
      rig = setupRigWith({ cellsFromWorld: true }, source(1, 2, 5));
      rig.setPlaying(false);
      rig.armBelt();
      press(rig, centre(3, 5));
      move(rig, centre(4, 5));
      move(rig, centre(5, 5));
      release(rig, centre(5, 5));
      const sentAfterFirst = rig.sent.length;
      press(rig, centre(3, 5));
      move(rig, centre(3, 6));
      move(rig, centre(3, 7));
      const secondPreviewValid = rig.overlay.beltCalls.at(-1)?.valid ?? null;
      release(rig, centre(3, 7));
      const sentAfterSecond = rig.sent.length;
      console.log(
        `P88-B6 sentAfterFirst=${sentAfterFirst} sentAfterSecond=${sentAfterSecond} secondPreviewValid=${secondPreviewValid}`,
      );
      expect(sentAfterFirst, 'PRECONDITION: the first draw sent its DrawBelt').toBe(1);
      expect(secondPreviewValid, 'the second drag from the held doorstep previews red').toBe(false);
      expect(sentAfterSecond, 'and is sent, so the host says why on Play').toBe(2);
      expect(rig.sentClaims[1], 'with no claim of its own').toBeUndefined();
    },
  );

  it('a_held_belts_doorstep_claim_is_not_read_in_a_later_table (phase 88 review, WR-01)', () => {
    // A paused board at generation 0. The user draws a belt off Source 1's Out doorstep (3,5);
    // its claim takes source (1, Out 0), a handle of generation 0's table. Then a Step applies
    // an Undo queued ahead of it: the keyframe of generation 1 re-mints every handle, the
    // Source is handle 2 now and handle 1 names machine M at (8,9), whose Out faces (9,9). The
    // DrawBelt is still queued, so its claim lives on. A drag off M's Out must preview build
    // and be sent, docked to M's Out: handle 1 in generation 1 is not the machine the claim
    // took, so M's doorstep is free and the press takes it as the belt's source. The Source's
    // own doorstep stays blocked through the claimed tiles, which are world cells.
    rig = setupRigWith({ cellsFromWorld: true }, source(1, 2, 5));
    rig.setPlaying(false);
    rig.armBelt();
    press(rig, centre(3, 5));
    move(rig, centre(4, 5));
    move(rig, centre(5, 5));
    release(rig, centre(5, 5));
    expect(rig.sent, 'PRECONDITION: the first draw sent its DrawBelt').toHaveLength(1);
    const s0 = rig.scene.nodes.get(1)!;
    rig.scene.nodes.clear();
    rig.scene.nodes.set(2, { ...s0, id: 2 });
    rig.scene.nodes.set(1, source(1, 8, 9));
    rig.scene.generation = 1;
    rig.clearSel();
    press(rig, centre(9, 9));
    move(rig, centre(10, 9));
    move(rig, centre(11, 9));
    const preview = rig.overlay.beltCalls.at(-1);
    release(rig, centre(11, 9));
    expect(cellsOf(preview?.tiles), 'PRECONDITION: the preview is of this drag').toEqual([
      [9, 9],
      [10, 9],
      [11, 9],
    ]);
    expect(preview?.valid, 'the drag previews build').toBe(true);
    expect(rig.sent, 'and its DrawBelt is sent').toHaveLength(2);
    expect(
      rig.sentClaims[1]?.sources,
      "M's Out doorstep is free in generation 1: the press took it as the belt's source",
    ).toEqual([{ node: 1, port: 0 }]);
    expect(rig.overlay.nubRingCalls.at(-1), 'and armed its ring').toEqual({ pt: centre(9, 9), armed: true });
  });

  it('a shared doorstep paints TWO concentric rings, and the press fills the MACHINE\'s', () => {
    // UI Considerations `zero-one-many`. Source 1's Out faces E onto (3,5); belt 30 runs N
    // ending at (3,6), so its Head's doorstep is (3,5) too. Both are free, both ring at
    // one centre, and they read as one. Nodes are scanned first (plan 74.1-01's order),
    // so the press records the machine and fills the machine's ring only.
    rig = setupRigWith({ cellsFromWorld: true }, source(1, 2, 5));
    rig.scene.belts.set(
      30,
      mkBelt(30, [
        [3, 7],
        [3, 6],
      ]),
    );
    rig.armBelt();
    expect(lastDockTargets(rig)).toEqual([ring(3, 5), ring(3, 5)]);
    press(rig, centre(3, 5));
    expect(lastDockTargets(rig)).toEqual([ring(3, 5, true), ring(3, 5, false)]);
    expect(rig.overlay.nubRingCalls.at(-1)).toEqual({ pt: centre(3, 5), armed: true });
  });

  it('a board with no free source arms cleanly and rings NOTHING; a single-tile belt is no press target', () => {
    // CORNER-04 probe `empty`: an In-only Sink, an Electrical Out, a linked Head and a
    // single-tile belt (no inherent direction, so no Head port). Arming throws nothing and
    // paints an EMPTY list. A press past the single-tile belt is a plain seed: no ring.
    // The linked Head (74.1-11, review IN-03, which found the comment named it and the
    // board did not hold it): belt 41 runs N (7,7) -> (7,5) and Head-docks the Sink's In
    // sideways, leaving its own doorstep (7,4) free, so only `headTaken` keeps it unringed.
    const electrical = node({
      id: 3,
      kind: machine_kind.SOURCE,
      cell_x: 12,
      cell_y: 5,
      ports: [{ index: 0, cell_x: 12, cell_y: 5, side: 1, role: 1, medium: MEDIUM_ELECTRICAL }],
    });
    rig = setupRigWith({ cellsFromWorld: true }, sink(2), electrical);
    rig.scene.belts.set(40, mkBelt(40, [[4, 0]]));
    rig.scene.belts.set(
      41,
      mkBelt(
        41,
        [
          [7, 7],
          [7, 6],
          [7, 5],
        ],
        [{ end: 'Head', node: 2, port: 0 }],
      ),
    );
    expect(() => rig!.armBelt()).not.toThrow();
    expect(rig.overlay.dockTargetCalls, 'the ring set WAS painted, empty').toHaveLength(1);
    expect(lastDockTargets(rig)).toEqual([]);
    press(rig, centre(5, 0));
    expect(rig.overlay.nubRingCalls).toHaveLength(0);
    expect(cellsOf(rig.overlay.beltCalls.at(-1)?.tiles), 'a plain seed under the hand').toEqual([[5, 0]]);
    expect(rig.overlay.beltCalls.at(-1)?.valid).toBe(true);
  });

  it('N free sources paint N rings: no cap (overflow)', () => {
    rig = setupRigWith(
      { cellsFromWorld: true },
      source(1, 2, 0),
      source(2, 2, 2),
      source(3, 2, 4),
      source(4, 2, 6),
      source(5, 2, 8),
    );
    rig.armBelt();
    expect(lastDockTargets(rig)).toEqual([ring(3, 0), ring(3, 2), ring(3, 4), ring(3, 6), ring(3, 8)]);
  });
});

// ===========================================================================
// Phase 76 (SHAPE-10, D-04, UI-SPEC U-4): the Label tool. A label never turns, and
// placing one is ONE-SHOT: the echo lets the tool go and selects the new label.
// ===========================================================================
describe('the Label tool (phase 76)', () => {
  const rKey = (shift: boolean) => ({ key: shift ? 'R' : 'r', shiftKey: shift, preventDefault: () => {} });
  const label = (id: number, cx: number, cy: number): NodeView =>
    node({ id, kind: machine_kind.LABEL, cell_x: cx, cell_y: cy, w: 4, h: 1 });

  it('arming the Label tool shows a 4x1 ghost with no nubs, and R neither turns it nor queues a Rotate', () => {
    rig = setupRig();
    rig.begin(machine_kind.LABEL);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(5, 5) });
    expect(rig.overlay.ghostCalls.at(-1)?.dims).toEqual({ w: 4, h: 1, rot: 0 });
    expect(rig.overlay.ghostCalls.at(-1)?.ports ?? []).toEqual([]);
    const ghostsBefore = rig.overlay.ghostCalls.length;
    rig.win.fire('keydown', rKey(false));
    rig.win.fire('keydown', rKey(true));
    expect(rig.overlay.ghostCalls.length, 'R re-rendered no ghost').toBe(ghostsBefore);
    expect(rig.overlay.ghostCalls.at(-1)?.dims).toEqual({ w: 4, h: 1, rot: 0 });
    // Commit, echo: exactly ONE Place and no Rotate follows it.
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(5, 5) });
    expect(rig.sent).toHaveLength(1);
    expect(rig.sent[0][0]).toBe(0); // Place discriminant
    rig.accept(1, [42]);
    rig.scene.nodes.set(42, label(42, 5, 5));
    rig.flushRaf();
    rig.flushRaf();
    expect(rig.sent, 'no Rotate rides the label echo').toHaveLength(1);
  });

  it('R with a label selected sends nothing', () => {
    rig = setupRig(label(7, 2, 2));
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(3, 2) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(3, 2) });
    expect(rig.overlay.selections).toEqual([7]);
    rig.win.fire('keydown', rKey(false));
    rig.win.fire('keydown', rKey(true));
    expect(rig.sent).toHaveLength(0);
  });

  it('the echo of a label Place lets the tool go and selects the label on both channels', () => {
    rig = setupRig();
    rig.begin(machine_kind.LABEL);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(5, 5) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(5, 5) });
    expect(rig.sent).toHaveLength(1);
    // Before the echo the tool is still in hand (a refused Place never echoes).
    expect(rig.armedCalls.at(-1)).toEqual({ kind: 'machine', machineKind: machine_kind.LABEL });
    rig.accept(1, [42]);
    rig.scene.nodes.set(42, label(42, 5, 5));
    rig.flushRaf();
    expect(rig.armedCalls.at(-1), 'the Label tool was put down').toBeNull();
    expect(rig.selectedId()).toBe(42);
    expect(rig.overlay.selections.at(-1)).toBe(42);
    expect(rig.onSelectCalls.at(-1)).toBe(42);
    expect(rig.onSelectBeltCalls.at(-1)).toBeNull();
    // Disarmed: a second click on another empty cell places nothing.
    rig.win.fire('pointermove', { target: rig.canvas, ...at(5, 9) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(5, 9) });
    expect(rig.sent).toHaveLength(1);
  });

  it('a label echo from placement asks for the Text field focus, after the select (76-02)', () => {
    rig = setupRig();
    rig.begin(machine_kind.LABEL);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(5, 5) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(5, 5) });
    expect(rig.onLabelPlacedCalls, 'nothing is asked before the echo').toEqual([]);
    rig.accept(1, [42]);
    rig.scene.nodes.set(42, label(42, 5, 5));
    rig.flushRaf();
    expect(rig.onSelectCalls.at(-1)).toBe(42);
    expect(rig.onLabelPlacedCalls, 'the placed label asks for focus exactly once').toEqual([42]);
    rig.flushRaf();
    expect(rig.onLabelPlacedCalls, 'and never again on a later frame').toEqual([42]);
  });

  it('a plain click on an existing label selects it WITHOUT asking for focus (76-02)', () => {
    rig = setupRig(label(7, 2, 2));
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(3, 2) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(3, 2) });
    expect(rig.onSelectCalls.at(-1)).toBe(7);
    expect(rig.onLabelPlacedCalls, 'a select is not a placement').toEqual([]);
  });

  it('a MACHINE echo never asks for label focus (76-02)', () => {
    rig = setupRig();
    rig.begin(machine_kind.SOURCE);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(5, 5) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(5, 5) });
    rig.accept(1, [42]);
    rig.scene.nodes.set(42, node({ id: 42, kind: machine_kind.SOURCE, cell_x: 5, cell_y: 5 }));
    rig.flushRaf();
    expect(rig.onLabelPlacedCalls).toEqual([]);
  });

  it('a label Place the host refuses leaves the tool armed', () => {
    rig = setupRig();
    rig.begin(machine_kind.LABEL);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(5, 5) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(5, 5) });
    // The host refuses it (phase 88: its own verdict ends it), and no echo ever lands.
    rig.refuse(1, 'FootprintCollision');
    rig.flushRaf();
    expect(rig.armedCalls.at(-1)).toEqual({ kind: 'machine', machineKind: machine_kind.LABEL });
    expect(rig.onSelectCalls).toEqual([]);
    // Still armed: the next click on a free cell places again.
    rig.win.fire('pointermove', { target: rig.canvas, ...at(5, 9) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(5, 9) });
    expect(rig.sent).toHaveLength(2);
  });

  it('a MACHINE echo still keeps its tool armed (IX-06 repeat placement is untouched)', () => {
    rig = setupRig();
    rig.begin(machine_kind.SOURCE);
    rig.win.fire('pointermove', { target: rig.canvas, ...at(5, 5) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(5, 5) });
    rig.accept(1, [42]);
    rig.scene.nodes.set(42, node({ id: 42, kind: machine_kind.SOURCE, cell_x: 5, cell_y: 5 }));
    rig.flushRaf();
    expect(rig.armedCalls.at(-1)).toEqual({ kind: 'machine', machineKind: machine_kind.SOURCE });
    expect(rig.onSelectCalls).toEqual([]);
  });
});

// ===========================================================================
// Phase 88, plan 88-07 (BELT-06, D-09): the other queued gestures occupy the editor too
// ===========================================================================
//
// A Dock, a Place and a label grow sent on a paused board wait for Play like a held belt does.
// Each registers its claim at the send seam (the rig's, as App's), and the one occupancy read
// and the source terms count it, so the ring, the ghost, the belt path and the label outline
// all say no before Play to what the host would refuse on Play. A queued Delete claims
// nothing (research Finding F). The rings and the ghost stay predictions, never gates: a drop
// and a Place over a claim are still SENT, and only the belt path check, a gate since phase 64
// (D-09), withholds its DrawBelt.
describe('queued Docks, Places, label grows and Deletes on a paused board (plan 88-07, BELT-06)', () => {
  let r: Rig | null = null;
  afterEach(() => {
    r?.destroy();
    r = null;
  });

  const centre = (cx: number, cy: number): Pt => ({ x: cx * CELL + CELL / 2, y: cy * CELL + CELL / 2 });
  const frac = (cx: number, cy: number, fx: number, fy: number): Pt => ({ x: (cx + fx) * CELL, y: (cy + fy) * CELL });
  const atW = (p: Pt) => ({ clientX: p.x, clientY: p.y });
  const belt = (id: number, cells: Array<[number, number]>): BeltView => {
    const routed = route(cells);
    if (!routed.ok) throw new Error('fixture path must route');
    return { id, latency: 4 * cells.length, fill: 0, items: [], tiles: routed.tiles, docks: [], ticks_per_slot: 1 };
  };
  const clickW = (rig: Rig, p: Pt): void => {
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(p) });
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...atW(p) });
  };
  const dockFrames = (rig: Rig) => rig.sent.filter((f) => f[0] === 4).map((f) => [...f]);
  const placeFrames = (rig: Rig) => rig.sent.filter((f) => f[0] === 0);
  const drawFrames = (rig: Rig) => rig.sent.filter((f) => f[0] === 3);
  const lastRing = (rig: Rig) => rig.overlay.nubRingCalls[rig.overlay.nubRingCalls.length - 1];
  const lastTargets = (rig: Rig) => rig.overlay.dockTargetCalls[rig.overlay.dockTargetCalls.length - 1] ?? [];
  const ringAt = (pts: Array<{ x: number; y: number }>, p: Pt) => pts.some((q) => q.x === p.x && q.y === p.y);
  const lastGhostValid = (rig: Rig) => rig.overlay.ghostCalls[rig.overlay.ghostCalls.length - 1]?.valid ?? null;

  // The review's board (74.1-paused-edits leg 7): A (1,5)-(3,5) east, its Head at (3,5); D's
  // Tail (3,4) just above A's Head and E's Tail (3,6) just below it.
  const A = 30;
  const D = 31;
  const E = 32;
  const boardADE = (rig: Rig): void => {
    rig.scene.belts.set(A, belt(A, [[1, 5], [2, 5], [3, 5]]));
    rig.scene.belts.set(D, belt(D, [[3, 4], [3, 3], [3, 2]]));
    rig.scene.belts.set(E, belt(E, [[3, 6], [3, 7], [3, 8]]));
  };
  /** Select belt `mid`'s middle tile, press inside its Tail tile `tail`, walk onto A's Head. */
  const dragTailOntoAHead = (rig: Rig, mid: [number, number], tail: [number, number]): void => {
    clickW(rig, centre(...mid));
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...atW(frac(...tail, 0.7, 0.7)) });
    rig.win.fire('pointermove', { target: rig.canvas, ...atW(frac(3, 5, 0.4, 0.6)) });
  };

  it('a_queued_dock_takes_its_belt_end: a second drag onto a belt end a queued Dock names shows no accepting ring', () => {
    r = setupRigWith({ cellsFromWorld: true });
    r.setPlaying(false);
    boardADE(r);
    dragTailOntoAHead(r, [3, 3], [3, 4]);
    expect(r.cursor(), "NON-VACUITY: the press on D's Tail began a handle drag").toBe('grabbing');
    expect(lastRing(r), "NON-VACUITY: A's free Head accepts D's Tail").toEqual({ pt: centre(3, 5), armed: true });
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...atW(frac(3, 5, 0.4, 0.6)) });
    expect(dockFrames(r), "D's join is sent and waits for Play").toEqual([
      [...encodeGridCommand({ kind: 'Dock', belt: D, end: 'Tail', node: A, port: BELT_PORT_HEAD })],
    ]);

    dragTailOntoAHead(r, [3, 7], [3, 6]);
    expect(r.cursor(), "the press on E's Tail began a handle drag").toBe('grabbing');
    expect(lastRing(r), "A's Head is taken by the queued Dock: the drop ring over it is passive").toEqual({
      pt: centre(3, 5),
      armed: false,
    });
    expect(ringAt(lastTargets(r), centre(3, 5)), "and no resting ring offers A's Head").toBe(false);
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...atW(frac(3, 5, 0.4, 0.6)) });
    // A RING IS A PREDICTION, NEVER A GATE (D-07; the joined-Head cases above pin the same rule
    // for a folded join): the drop is still sent and the host answers it `BeltEndTaken`.
    expect(dockFrames(r), "E's drop is still sent, for the host to refuse in words").toHaveLength(2);
    // Each answer ends its own claim. E's drop claims A's Head too, so D's refusal alone leaves
    // it taken; once both are answered, A's Head is free again for the next drag.
    r.refuse(1, 'BeltEndTaken');
    dragTailOntoAHead(r, [3, 7], [3, 6]);
    expect(lastRing(r), "D's join refused, E's drop still queued: taken").toEqual({ pt: centre(3, 5), armed: false });
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...atW(frac(3, 5, 0.4, 0.6)) });
    r.refuse(2, 'BeltEndTaken');
    r.refuse(3, 'BeltEndTaken');
    dragTailOntoAHead(r, [3, 7], [3, 6]);
    expect(lastRing(r), "every drop answered: A's Head accepts again").toEqual({ pt: centre(3, 5), armed: true });
  });

  it('a_pending_place_occupies_its_footprint: the ghost over it reads invalid (still sent, flashing red) and a belt path through it is drawn red and sent with no claim', () => {
    r = setupRig();
    r.setPlaying(false);
    r.begin(machine_kind.SOURCE);
    r.win.fire('pointermove', { target: r.canvas, ...at(5, 5) });
    expect(lastGhostValid(r), 'NON-VACUITY: (5,5) is free before the Place').toBe(true);
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...at(5, 5) });
    expect(placeFrames(r), 'the Place is sent and waits for Play').toHaveLength(1);
    expect(lastGhostValid(r), 'the re-shown ghost over the queued Place reads invalid').toBe(false);
    r.win.fire('pointermove', { target: r.canvas, ...at(6, 5) });
    expect(lastGhostValid(r), 'NON-VACUITY: the cell beside it is free').toBe(true);
    r.win.fire('pointermove', { target: r.canvas, ...at(5, 5) });
    expect(lastGhostValid(r), 'back over the queued Place: invalid').toBe(false);
    // THE GHOST IS ADVISORY (phase 64, D-07): a second drop is still sent, with the red flash.
    const flashes = r.overlay.rejectFlashCalls.length;
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...at(5, 5) });
    expect(placeFrames(r), 'a drop over the queued Place is still sent').toHaveLength(2);
    expect(r.overlay.rejectFlashCalls.length, 'flashing red').toBe(flashes + 1);
    // THE BELT PATH CHECK PAINTS AND FLASHES, IT DOES NOT GATE (plan 89-09, D-13): a path
    // through (5,5) is drawn red and, like the drop above, is still sent (with no claim), so the
    // host refuses it in words on Play; the flash names the queued Place's cell.
    r.armBelt();
    r.canvas.fire('pointerdown', { button: 0, target: r.canvas, ...at(3, 5) });
    for (const cx of [4, 5, 6]) {
      r.win.fire('pointermove', { target: r.canvas, ...at(cx, 5) });
    }
    expect(r.overlay.beltCalls.at(-1)?.valid, 'the path through the queued Place is drawn as not allowed').toBe(false);
    const before = r.sent.length;
    const flashesBefore = r.overlay.rejectFlashCalls.length;
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...at(6, 5) });
    expect(drawFrames(r), 'and is sent as one DrawBelt').toHaveLength(1);
    expectIllegalDrawSent(r, 'the path through the queued Place', before);
    expect(r.overlay.rejectFlashCalls.slice(flashesBefore).map((c) => c.cell), 'ONE flash, on the queued cell').toEqual([
      { cx: 5, cy: 5 },
    ]);
  });

  it("a_queued_label_grow_occupies_its_new_cells: the ghost over them reads invalid, and a queued Place makes the label's grow outline not fit", () => {
    const LABEL = 9;
    r = setupRig(node({ id: LABEL, kind: machine_kind.LABEL, cell_x: 10, cell_y: 12, w: 4, h: 1 }));
    r.setPlaying(false);
    // The label panel's Apply, as App's send seam registers it (ConfigPanel's `commitConfig`
    // builds this claim, pinned in ConfigPanel.test.tsx): 4 by 1 grown to 6 by 1.
    r.claims.add(900, resizeClaim({ id: LABEL, cx: 10, cy: 12, w: 4, h: 1 }, 6, 1), { generation: r.scene.generation });
    r.begin(machine_kind.SOURCE);
    r.win.fire('pointermove', { target: r.canvas, ...at(15, 13) });
    expect(lastGhostValid(r), 'NON-VACUITY: the cell below the grow is free').toBe(true);
    r.win.fire('pointermove', { target: r.canvas, ...at(15, 12) });
    expect(lastGhostValid(r), 'the ghost over a cell the queued grow takes reads invalid').toBe(false);
    // A Place queued at (10,14), then the label's outline asked as App's `paintLabelResize` asks
    // it: the one prediction with the label's own cells (and its own claim) excluded.
    r.win.fire('pointermove', { target: r.canvas, ...at(10, 14) });
    r.win.fire('pointerup', { button: 0, target: r.canvas, ...at(10, 14) });
    expect(placeFrames(r), 'the Place is sent and waits').toHaveLength(1);
    const anchor = { cx: 10, cy: 12 };
    expect(footprintFits(r.scene, anchor, { w: 6, h: 2, rot: 0 }, LABEL), 'NON-VACUITY: 6 by 2 fits, its own grow excluded').toBe(
      true,
    );
    expect(footprintFits(r.scene, anchor, { w: 6, h: 3, rot: 0 }, LABEL), '6 by 3 covers the queued Place: not fitting').toBe(
      false,
    );
  });

  it('a_queued_delete_does_not_free_its_cells: the ghost over a node with a queued Delete still reads invalid', () => {
    r = setupRig(node({ id: 3, kind: machine_kind.SOURCE, cell_x: 5, cell_y: 5 }));
    r.setPlaying(false);
    r.commit(3);
    expect(r.sent.map((f) => [...f]), 'the Delete is sent and waits for Play').toEqual([
      [...encodeGridCommand({ kind: 'Delete', node: 3 })],
    ]);
    // Review fix pass 1 (WR-A-04): the Delete's claim names its node for the cable preview and
    // takes no cell, so the occupancy read is unchanged (research Finding F).
    expect(r.claims.size(), 'the Delete registers one claim').toBe(1);
    expect(r.sentClaims[0]?.cells.size, 'and it takes no cell').toBe(0);
    expect(r.sentClaims[0]?.deletes, 'it names the node it removes').toBe(3);
    r.begin(machine_kind.SINK);
    r.win.fire('pointermove', { target: r.canvas, ...at(5, 5) });
    expect(lastGhostValid(r), 'the node still takes its cell until the Delete folds').toBe(false);
    r.win.fire('pointermove', { target: r.canvas, ...at(7, 5) });
    expect(lastGhostValid(r), 'NON-VACUITY: a free cell reads valid').toBe(true);
  });
});

// Phase 90 (FAIL-01, D-12, UI-SPEC 1.4): once the host's sim loop has ended nothing on the board
// may send to it, and nothing may look as though it did. Looking around still works: Escape runs,
// the camera keeps its pan (the controller never takes it), and App's own keys are not here.
describe('a stopped simulation (FAIL-01)', () => {
  const press = (r: Rig, button: number, cx: number, cy: number): void => {
    r.canvas.fire('pointerdown', { button, target: r.canvas, pointerId: 1, ...at(cx, cy) });
    r.win.fire('pointerup', { button, target: r.canvas, pointerId: 1, ...at(cx, cy) });
  };
  const k = (over: Record<string, unknown>) => ({
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault: () => {},
    ...over,
  });

  it('a press on a machine selects nothing and sends nothing, left or right', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    rig.simStopped.on = true;
    press(rig, 0, 2, 2);
    press(rig, 2, 2, 2);
    expect(rig.selectedId()).toBeNull();
    expect(rig.onSelectCalls).toEqual([]);
    expect(rig.sent).toHaveLength(0);
    // The controller left the camera's pan alone, so the board can still be moved.
    expect(rig.panState.enabled).toBe(true);
  });

  it('the same press on a running board selects the machine (so the case above discriminates)', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    press(rig, 0, 2, 2);
    expect(rig.selectedId()).toBe(7);
  });

  it('palette arming is refused', () => {
    rig = setupRig();
    rig.simStopped.on = true;
    rig.begin(machine_kind.SOURCE);
    rig.beginRouterPreset(0);
    rig.armBelt();
    rig.armWire();
    expect(rig.armedCalls).toEqual([]);
    expect(rig.panState.enabled).toBe(true);
  });

  it('Space, ".", R, Delete, Backspace and the Ctrl accelerators call nothing and send nothing', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    // Selected while running, then the sim stops (App's standDown is exercised below).
    press(rig, 0, 2, 2);
    expect(rig.selectedId()).toBe(7);
    rig.simStopped.on = true;
    let prevented = 0;
    const pd = (): void => {
      prevented += 1;
    };
    for (const e of [
      k({ key: ' ' }),
      k({ key: '.' }),
      k({ key: 'r' }),
      k({ key: 'R', shiftKey: true }),
      k({ key: 'Delete' }),
      k({ key: 'Backspace' }),
    ]) {
      rig.win.fire('keydown', e);
    }
    for (const key of ['s', 'S', 'n', 'o', 'z', 'y']) {
      rig.win.fire('keydown', k({ key, ctrlKey: true, preventDefault: pd }));
    }
    rig.win.fire('keydown', k({ key: 'z', ctrlKey: true, shiftKey: true, preventDefault: pd }));
    rig.win.fire('keydown', k({ key: 's', metaKey: true, preventDefault: pd }));
    expect(rig.calls).toEqual({ play: 0, step: 0, save: 0, newBoard: 0, open: 0 });
    expect(rig.counts).toEqual({ undo: 0, redo: 0 });
    expect(rig.sent).toHaveLength(0);
    expect(rig.deleteWithItems).toEqual([]);
    // The browser's own Save, New, Open and undo bindings are still prevented.
    expect(prevented).toBe(8);
  });

  it('the same keys reach their deps on a running board (so the case above discriminates)', () => {
    rig = setupRig();
    rig.win.fire('keydown', k({ key: ' ' }));
    rig.win.fire('keydown', k({ key: '.' }));
    rig.win.fire('keydown', k({ key: 's', ctrlKey: true }));
    rig.win.fire('keydown', k({ key: 'n', ctrlKey: true }));
    rig.win.fire('keydown', k({ key: 'o', ctrlKey: true }));
    rig.win.fire('keydown', k({ key: 'z', ctrlKey: true }));
    expect(rig.calls).toEqual({ play: 1, step: 1, save: 1, newBoard: 1, open: 1 });
    expect(rig.counts).toEqual({ undo: 1, redo: 0 });
  });

  it('Escape still runs on a stopped board', () => {
    rig = setupRig();
    rig.simStopped.on = true;
    rig.win.fire('keydown', k({ key: 'Escape' }));
    expect(rig.escapeFallback.count).toBe(1);
  });

  it('standDown ends a draw in flight, puts the tool away and clears the selection, nothing sent', () => {
    rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
    press(rig, 0, 2, 2);
    expect(rig.selectedId()).toBe(7);
    rig.armBelt();
    rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, pointerId: 1, ...at(5, 5) });
    rig.win.fire('pointermove', { button: 0, target: rig.canvas, pointerId: 1, buttons: 1, ...at(8, 5) });
    expect(rig.overlay.beltPreview.on, 'a belt path is being drawn').toBe(true);
    const sentBefore = rig.sent.length;

    rig.simStopped.on = true;
    rig.standDown();

    expect(rig.armedCalls.at(-1), 'the Belt tool is put away').toBeNull();
    expect(rig.overlay.beltPreview.on, 'the drawn path is gone').toBe(false);
    expect(rig.selectedId()).toBeNull();
    expect(rig.onSelectCalls.at(-1), 'App is told, so the panel closes').toBeNull();
    expect(rig.onSelectBeltCalls.at(-1)).toBeNull();
    expect(rig.panState.enabled).toBe(true);
    // The release after the stop sends nothing either.
    rig.win.fire('pointerup', { button: 0, target: rig.canvas, pointerId: 1, ...at(8, 5) });
    expect(rig.sent.length).toBe(sentBefore);
  });

  it('standDown puts an armed placement away', () => {
    rig = setupRig();
    rig.begin(machine_kind.FACTORY);
    expect(rig.armedCalls.at(-1)).toEqual(expect.objectContaining({ kind: 'machine' }));
    rig.simStopped.on = true;
    rig.standDown();
    expect(rig.armedCalls.at(-1)).toBeNull();
    expect(rig.sent).toHaveLength(0);
  });
});

// Phase 91 (D-11, CHROME-11, research Finding K): ONE shortcut table (`shortcuts.ts`) is read by
// this controller's `onKey`, App's Home and Alt listeners and the Help panel. These cases make
// the table and the handler unable to drift apart: every entry the controller owns, pressed
// through the key rig with each of its keys, reaches its own dep exactly once and nothing else;
// and the controller holds no key literal of its own for a key the table owns.
describe('every shortcut table entry the controller owns reaches its action (CHROME-11)', () => {
  /** Every counter a key can move, read as one plain object so "nothing else fired" is one equality. */
  const reading = (r: Rig) => ({
    play: r.calls.play,
    step: r.calls.step,
    save: r.calls.save,
    saveArgs: [...r.saveArgs],
    newBoard: r.calls.newBoard,
    open: r.calls.open,
    undo: r.counts.undo,
    redo: r.counts.redo,
    escapeFallback: r.escapeFallback.count,
    sent: r.sent.map((b) => [b[0], b[b.length - 1]]),
  });
  type Reading = ReturnType<typeof reading>;
  const NONE: Reading = {
    play: 0, step: 0, save: 0, saveArgs: [], newBoard: 0, open: 0, undo: 0, redo: 0, escapeFallback: 0, sent: [],
  };
  // The one action each entry must have, as a change from NONE. Rotate is GridCommand disc 2
  // with its ccw byte last; Delete is disc 1 with the node id last (the cases above).
  const EFFECT: Partial<Record<ShortcutId, { selectNode: boolean; want: Partial<Reading> }>> = {
    save: { selectNode: false, want: { save: 1, saveArgs: [false] } },
    saveAs: { selectNode: false, want: { save: 1, saveArgs: [true] } },
    newBoard: { selectNode: false, want: { newBoard: 1 } },
    open: { selectNode: false, want: { open: 1 } },
    undo: { selectNode: false, want: { undo: 1 } },
    redo: { selectNode: false, want: { redo: 1 } },
    redoY: { selectNode: false, want: { redo: 1 } },
    playPause: { selectNode: false, want: { play: 1 } },
    step: { selectNode: false, want: { step: 1 } },
    rotate: { selectNode: true, want: { sent: [[2, 0]] } },
    rotateBack: { selectNode: true, want: { sent: [[2, 1]] } },
    delete: { selectNode: true, want: { sent: [[1, 7]] } },
    escape: { selectNode: false, want: { escapeFallback: 1 } },
  };

  it('names an action for every entry the controller owns, and for no other', () => {
    const owned = SHORTCUT_LIST.filter((s) => s.owner === 'gestures').map((s) => s.id).sort();
    expect(Object.keys(EFFECT).sort()).toEqual(owned);
    // App's own two (Home fits, Alt shows names) are read in App.tsx through the same matcher.
    expect(SHORTCUT_LIST.filter((s) => s.owner === 'app').map((s) => s.id).sort()).toEqual(['fit', 'names']);
  });

  const owned: Shortcut[] = SHORTCUT_LIST.filter((s) => s.owner === 'gestures');
  for (const s of owned) {
    for (const key of s.keys) {
      it(`${s.id} (${s.label}) on key ${JSON.stringify(key)} fires its action exactly once`, () => {
        const effect = EFFECT[s.id]!;
        rig = setupRig(node({ id: 7, cell_x: 2, cell_y: 2 }));
        if (effect.selectNode) {
          rig.canvas.fire('pointerdown', { button: 0, target: rig.canvas, ...at(2, 2) });
          rig.win.fire('pointerup', { button: 0, target: rig.canvas, ...at(2, 2) });
          expect(rig.selectedId()).toBe(7);
        }
        const e = {
          key,
          ctrlKey: s.ctrl === true,
          metaKey: false,
          shiftKey: s.shift === true,
          repeat: false,
          preventDefault: () => {},
        };
        expect(matchesShortcut(e, s), 'the rig presses the entry it names').toBe(true);
        rig.win.fire('keydown', e);
        expect(reading(rig)).toEqual({ ...NONE, ...effect.want });
      });
    }
  }

  it('gestures.ts holds no key literal for a key the table owns (comments aside)', () => {
    const raw = readFileSync(join(import.meta.dirname, 'gestures.ts'), 'utf8');
    // Block comments, then line comments that start a line or follow whitespace (a `//` inside
    // a string such as a URL keeps the rest of its line).
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
    const keys = [...new Set(SHORTCUT_LIST.flatMap((t) => [...t.keys]))];
    const esc = (k: string): string => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const k of keys) {
      const lit = new RegExp(`\\be\\.key\\s*[!=]==?\\s*(['"\`])${esc(k)}\\1`);
      expect(lit.test(src), `gestures.ts compares e.key with ${JSON.stringify(k)} itself`).toBe(false);
    }
    // And no key test of another shape (the stopped guard used to be /^[snozy]$/i.test(e.key)).
    expect(src, 'no regex test over e.key').not.toMatch(/\.test\(\s*e\.key\s*\)/);
    // Phase 91 review IN-A-03: every other spelling of a key read, not just `e.key === 'K'`. The
    // controller reads `KeyboardEvent.key` only inside `matchesShortcut` (shortcuts.ts), so here
    // no member read of `.key` on any name (`ev.key`, `event.key`, `switch (e.key)`,
    // `const k = e.key`, `.includes(e.key)`), no `['key']` index, no `{ key }` destructured from
    // an event, and no `case` label naming a table key.
    expect(src, 'no `.key` read on any name').not.toMatch(/\.key\b/);
    expect(src, "no ['key'] index").not.toMatch(/\[\s*(['"`])key\1\s*\]/);
    expect(src, 'no { key } destructured from an event').not.toMatch(/\{[^{}]*\bkey\b[^{}]*\}\s*(=|:\s*(KeyboardEvent|Pick)\b|\))/);
    for (const k of keys) {
      const label = new RegExp(`\\bcase\\s+(['"\`])${esc(k)}\\1\\s*:`);
      expect(label.test(src), `gestures.ts has a case label for the table key ${JSON.stringify(k)}`).toBe(false);
    }
    expect(src, 'the controller reads the table').toMatch(/matchesShortcut\(e, SHORTCUTS\./);
  });
});
