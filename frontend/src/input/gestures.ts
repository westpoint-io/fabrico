// gestures.ts — the authoritative gesture controller (VIS-05).
//
// Every gesture emits exactly ONE logged GridCommand (Place / Delete / Rotate /
// DrawBelt) through the transport; the canvas reflects only what the sim echoes
// back (SC5). NOTHING here mutates grid state — placement validity and the
// placement echo are all read off the live `sceneState` the host streams in. The
// controller DRIVES 07-07's overlay primitives (ghost / selection / hover / belt
// preview) via the structural `OverlayAffordances` handle passed in from App.tsx;
// it never imports `overlay.ts` directly.
//
// Pointer model (single window-level listener set so a drag survives leaving the
// canvas, mirroring the camera's pointer-capture pan):
//   - palette drag  -> beginPlacement(kind): ghost follows the cursor; drop on a
//                      valid cell emits Place and the ghost PERSISTS (build-blue)
//                      until the echo adds the node, covering the 1-frame latency.
//   - press on node -> a click (no drag) = select. The node->node Wire gesture was
//                      removed in Phase 17-02 (belts come ONLY from the DrawBelt
//                      tool + Dock); a drag on a node no longer wires anything.
//   - empty floor   -> left untouched so the camera pans (it owns that gesture).
//   - keyboard      -> Space = play/pause, '.' = step, Delete/Backspace = delete.
// Pan is suspended (cam.setPanEnabled(false)) for the duration of a place so the
// gesture is never shadowed by a pan, then restored.

import type { Camera, CellCoord } from '../render/camera';
import { cellsOfFootprint } from '../protocol/footprint';
import type { SceneState } from '../render/sceneState';
import type { ClientRefusalTag } from '../chrome/RefusalMessage';
// Type only: the verdict kinds are compared as their string literals below, so the gesture
// layer pulls in no transport module at runtime.
import type { GestureVerdict } from '../transport/transport';
import {
  catalogEntry,
  encodeGridCommand,
  type BeltEnd,
  type GridCommand,
  type BeltView,
  type NodeView,
  type PortView,
  type TileView,
} from '../protocol/decode';
import { route } from '../protocol/route';
import { seamEndTiles } from '../protocol/seam';
import {
  clearPendingSeams,
  endPendingSeams,
  recordPendingSeams,
  resumePendingSeams,
  setPendingSeamsPlayState,
} from '../render/pendingSeams';
import {
  acceptsDock,
  acceptsWireTarget,
  BELT_PORT_HEAD,
  BELT_PORT_TAIL,
  beltEndCell,
  beltEndOutward,
  beltEndPort,
  beltHandlePoints,
  beltTarget,
  dockCandidates,
  type DockTargetShape,
  MACHINE_TARGET,
  doorstepCell,
  FAULT_PORT,
  MEDIUM_ELECTRICAL,
  MEDIUM_MECHANICAL,
  mediumsCompatible,
  nubHitRadiusWorld,
  wireNubHitRadiusWorld,
  oppositeSide,
  PORT_ROLE,
  ROLE_IN,
  ROLE_OUT,
  sideOfUnitDelta,
  worldNubSpecs,
} from '../protocol/ports';
import { type WireBody, bodyOfNode, cellBody, isWireObstacle, wireRouteAvoiding } from '../protocol/wireRoute';
import { cableLane } from '../render/cableLane';
import { NO_NUB, nubEndAt, type CableNubs } from '../render/cableGeometry';
import { machine_kind } from '../protocol/kinds';
// The world-px cell pitch, read from the shared geometry module rather than restated:
// a belt end's hit point is its END TILE CENTRE, `cell * CELL + CELL / 2`.
import { CELL } from '../../shared/geometry';
import {
  cellOccupied,
  createGhostController,
  GRID_MAX,
  GRID_MIN,
  MAX_BELT_TILES,
  nodeAtCell,
  type OverlayAffordances,
} from './ghost';
import { CLAIM_TTL_TICKS, beltClaim, deleteClaim, dockClaim, placeClaim, type QueuedClaim } from './queuedClaims';
import { CTRL_SHORTCUTS, SHORTCUTS, matchesShortcut } from './shortcuts';

export interface GestureDeps {
  /** The Pixi canvas — pointer geometry is taken relative to its bounding rect. */
  canvas: HTMLCanvasElement;
  /** Camera controller (screen↔cell + pan suspend). */
  cam: Camera;
  /** 07-07's overlay handle (driven, never imported). */
  overlay: OverlayAffordances;
  /** Read the live echoed scene (validity / wire targets / echo detection). */
  getScene: () => SceneState;
  /**
   * Send one encoded GridCommand to the host (the ONLY state-changing path). Returns the
   * gesture id the send seam framed it under (phase 88, D-06), which the host's verdict for
   * it names back as `seq`; 0 when nothing was sent. `opts.generation` names the board
   * generation of the handles the command carries: a follow-up addressed to a handle an
   * accept named passes that accept's generation, so the host reads the handle in the table
   * the accept was written from (plan 88-04). Omitted, the seam stamps the latest packet's.
   * `opts.claim` (phase 88, plan 88-07, D-09) is what the gesture will take once it folds,
   * built from the typed command still in hand; the seam registers it under the id it returns,
   * so the one occupancy read counts it as taken until the gesture's own answer ends it.
   */
  sendInput: (bytes: Uint8Array, opts?: { generation?: number; claim?: QueuedClaim; quiet?: boolean }) => number;
  /**
   * Whether the sim is playing, as the chrome believes it (phase 88, D-07). The one placement
   * timer left (a Place whose verdict was lost) and the pending-rotation record count only
   * ticks run while this is true: a paused board drains ticks with input held, and none of
   * those ticks is evidence a gesture was refused. Absent, the controller treats the sim as
   * playing.
   */
  isPlaying?: () => boolean;
  /** Space — toggle sim play/pause (App routes to the host pause/resume command, 18-05). */
  onTogglePlay?: () => void;
  /** '.' — single sim step (App routes to the host step command, 18-05). */
  onStep?: () => void;
  /**
   * Ctrl/Cmd+Z — undo the last edit (App emits a fieldless Undo GridCommand on
   * the GESTURE channel, gated on availability — 19-06 / UNDO-04). Undo/Redo ARE
   * edits and must fold EDITS-FIRST, so they ride sendInput, NOT the control seam.
   */
  onUndo?: () => void;
  /** Ctrl/Cmd+Shift+Z or Ctrl+Y — redo (mirror of {@link onUndo}). */
  onRedo?: () => void;
  /**
   * SAVE-03 keyboard Save. Ctrl/Cmd+S = smart-Save (re-save to the known path
   * with no dialog); Ctrl/Cmd+Shift+S forces Save-As (`saveAs=true`, always
   * prompts). App routes this to the SAME smart-Save closure the Toolbar Save
   * button uses. Sits behind the modal + editable-focus guards like undo/redo, so
   * it no-ops while a modal/guard owns the interaction.
   */
  onSave?: (saveAs?: boolean) => void;
  /**
   * SAVE-05 keyboard New. Ctrl/Cmd+N routes through App's dirty-guarded `doNew`
   * (consults dirtyRef -> the discard guard when dirty, else swaps to an empty
   * board). Sits behind the modal + editable-focus guards like Save, so it no-ops
   * while a guard is open or a chrome field owns focus.
   */
  onNew?: () => void;
  /**
   * SAVE-05 keyboard Open. Ctrl/Cmd+O routes through App's dirty-guarded `doOpen`
   * (the discard guard when dirty, else the native Open dialog). Same gating as
   * {@link onNew}.
   */
  onOpen?: () => void;
  /** Selection changed (id, or null when cleared) — lets the chrome react. */
  onSelect?: (id: number | null) => void;
  /**
   * BELT selection changed (belt handle, or null when cleared). BELT-01.
   *
   * A SECOND CHANNEL, deliberately, and NOT a widening of {@link onSelect}.
   * `selectedNode()` is the gate on the keyboard rotate target (`:2783`), the
   * keyboard Delete target (`:2792`), the exported `selectedId` (`:2824`) and -
   * through `onSelect` - App's DeleteControl mount. So a belt arriving on
   * `onSelect` would gain, in one line, the floating machine delete control and a
   * keyboard `Delete` that skips the belt's own items guard. 68-UI-SPEC FINDING 3
   * ruled that one-keystroke data loss out: `selectedNode()` and `selectedId()` take
   * a ZERO diff and a selected belt still reads as null to both. Since phase 89 (D-07)
   * a selected belt IS deleted by the Delete key and by its panel's button, through
   * its own guarded path, `requestBeltDelete`, which opens the guard when items are on it.
   *
   * BOTH CHANNELS ARE DRIVEN FROM ALL EIGHT SELECTION SITES, so `selectedNode`
   * and `selectedBelt` can never both be non-null. THE COUNT IS EIGHT (it was seven
   * until phase 76 added the label echo, the one site a gesture does not start) and the
   * rule is that every `deps.onSelect?.(...)` has a paired `onSelectBelt` call
   * in the same arm, so a future site that drives one and not the other is a
   * VISIBLE omission rather than an invisible one:
   *
   * | site | gesture | onSelect | onSelectBelt |
   * |------|---------|----------|--------------|
   * | stranded-ring press | grab an orphaned belt end | `null` | `null` |
   * | empty-floor press   | bare click to deselect    | `null` | `null` |
   * | press-release NODE  | select a machine          | `id`   | `null` |
   * | press-release BELT  | select a belt             | `null` | `id`   |
   * | `commitDelete`      | a logged Delete           | `null` | `null` |
   * | `clearSelection`    | keyframe teardown         | `null` | `null` |
   * | Escape              | IX-07 clear               | `null` | `null` |
   * | label echo          | a placed Label lands (U-4) | `id`  | `null` |
   *
   * EXACTLY ONE ROW CARRIES A NON-NULL BELT, and it is the press-release belt
   * arm. Wiring only that row is what the live suite catches: five paths would
   * clear the node selection and leave a stale belt selection behind, so the
   * belt's ConfigPanel stayed mounted over the whole right band and intercepted
   * pointer events for every later click in the session.
   *
   * `gestures.test.ts`'s table-driven case names each site by line number, so a
   * reader can check the list against
   * `grep -n 'deps.onSelect?.(' frontend/src/input/gestures.ts` rather than
   * trusting it.
   */
  onSelectBelt?: (id: number | null) => void;
  /**
   * A label this user just PLACED has echoed and been selected (phase 76, plan 76-02,
   * 76-UI-SPEC 2.1). Fired ONLY from the label-echo branch, AFTER {@link onSelect}, so the
   * chrome can hand the keyboard to the label's Text field once its config has loaded.
   * Never fired by a plain click on an existing label: that selects without moving focus,
   * so Delete, Ctrl+Z and the arrow keys keep reaching the board.
   */
  onLabelPlaced?: (id: number) => void;
  /**
   * Armed-tool changed (IX-03): the tool now "in hand" (a machine kind or the
   * Belt tool) or null when nothing is armed. Surfaced so the Palette can render
   * the pressed/active state (30-05 wires it; the callback is plumbed here). The
   * closure-to-React pattern mirrors {@link onSelect}. Fired on every arm AND
   * every disarm path (Esc / right-click / re-click / superseding tool switch).
   */
  onArmedChange?: (
    tool:
      // `presetMedium` is set ONLY for a ROUTE-06 Router preset (Electrical=1 HTTP,
      // Mechanical=0 Item); absent/null for a plain machine placement. It lets the
      // palette highlight the SPECIFIC armed preset (IX-03 exactly-one-armed) even
      // though all Router entries share machineKind = ROUTER.
      | { kind: 'machine'; machineKind: number; presetMedium?: number | null }
      | { kind: 'belt' }
      // The Wire tool (WIRE-02, plan 66-01), payload-free for the same reason the
      // Belt tool is: a wire is drawn nub to nub with nothing to pick beforehand.
      | { kind: 'wire' }
      | null,
  ) => void;
  /**
   * Delete requested on an element that still carries in-flight items (REND-03).
   * The gesture layer emits NOTHING here — it defers to the UI guard (App opens
   * the delete-guard dialog). The dialog resolves into exactly one `commitDelete`
   * (Delete anyway / drained-to-zero) or nothing (Cancel). `beltIds` are the
   * docked belts whose item counts App polls (via window.__fabrico) while draining.
   */
  onDeleteWithItems?: (
    handle: number,
    count: number,
    kind: 'belt' | 'machine',
    beltIds: number[],
  ) => void;
  /**
   * True while a modal (the delete-guard dialog) owns the interaction. When set,
   * the gesture layer ignores ALL global keyboard shortcuts so input meant for
   * the modal can't reach the canvas — e.g. a second `Delete` during a drain
   * must NOT re-enter the guard / spawn a concurrent drain loop (WR-01, SC5).
   */
  isModalOpen?: () => boolean;
  /**
   * Lowest-priority Escape action (ONB-01 / IX-07). Escape follows the Phase-30
   * escapable-stack priority, with phase 89's first rung on top (D-11): it FIRST ends a
   * belt path or a held wire source and keeps the tool, THEN disarms an armed tool, THEN
   * clears an active selection, and only when Escape was OTHERWISE A NO-OP (nothing
   * drawing, nothing armed, nothing selected) does it invoke this fallback. App wires it to dismiss the
   * first-run WelcomeCard, so the card-dismiss can never pre-empt a selection
   * clear (the old capture-phase card handler broke IX-07 by doing exactly that).
   */
  onEscapeFallback?: () => void;
  /**
   * A refusal the CLIENT words, raised where a press forms no command (plan 75-07, D-12).
   *
   * Today one caller and one tag: a Wire-tool press whose nearest port in range takes belts
   * only, with no electrical Out in range. App routes it to `showClientRefusal`, which writes
   * the closed `CLIENT_REFUSAL_COPY` sentence into the same single refusal slot as a host
   * verdict, without advancing the host's sequence bar, so a later host verdict replaces it.
   * Optional so a rig that does not care about the band can omit it; the reject flash fires
   * either way.
   */
  onClientRefusal?: (tag: ClientRefusalTag) => void;
  /**
   * FAIL-01 (phase 90, D-12, UI-SPEC 1.4): true once the host's sim loop has ended. While it
   * reads true nothing that would send to the host runs: a canvas press (any button but the
   * middle one, which the camera owns) selects and sends nothing, palette arming is refused, and
   * Space, `.`, R, Delete, Backspace and the Ctrl/Cmd S, N, O, Z and Y accelerators do nothing.
   * Escape, the camera (its own listeners: middle-button pan, the wheel) and App's own keys
   * (Home, Alt) run as shipped. Deliberately NOT `isModalOpen`, which would also swallow Escape.
   * Absent, the sim is running.
   */
  isSimStopped?: () => boolean;
}

/**
 * One pressable stranded-dock ring: the orphaned belt end a Rotate left dangling
 * (CONNECT-02). Built by App.tsx from a `StrandedDock` event and handed to the
 * gesture layer through {@link GestureController.setStrandedRings}.
 */
export interface StrandedRing {
  /** The orphaned belt's render handle - the `belt` field of the `Dock` a press emits. */
  beltId: number;
  /** WHICH end is orphaned, read VERBATIM off the `StrandedDock` record. */
  end: BeltEnd;
  /** The orphaned belt end's world point (the end tile's centre) - the ring's own centre. */
  pt: { x: number; y: number };
}

export interface GestureController {
  /** Arm placement of `kind` (a MachineKind u8): a palette click picks it, a floor click places it. */
  beginPlacement(kind: number): void;
  /**
   * The host's one answer to one gesture (phase 88, D-06), handed over by App for EVERY
   * verdict before the refusal band sees it. A pending Place is found by the gesture id its
   * send returned (`seq`): a refusal or a discard ends it at once and clears its own waiting
   * shimmer (D-10); an accept records the handle it minted and that handle's generation, and
   * the entry then waits for a packet that holds the handle before it sends its follow-ups,
   * addressed to that handle with that generation. A verdict for no pending Place, or for one
   * already ended, does nothing.
   */
  onVerdict(v: GestureVerdict): void;
  /**
   * The sim resumed at `tick` (phase 88, D-07). Every pending Place's fallback count and every
   * pending-rotation record restarts at `tick`, as `resumePortEdit` does for a port edit: the
   * ticks a pause drained ran with input held, so none of them counts. App calls this from
   * `setPlayingNow` beside the port-latch rebase.
   */
  onResume(tick: number): void;
  /**
   * A swap's keyframe was applied (phase 88, T-88-11): New, Open, an example or a Load
   * replaced the board, and the host discards every gesture stamped on the replaced one. Every
   * held belt and every pending Place ends here with nothing sent (a held belt's picture and
   * predicted seam with it), and no follow-up of an accept written before the swap is ever
   * named again in the new board's table. App calls this where the swap keyframe ends the
   * queued claims, before `clearSelection`.
   */
  onSwap(): void;
  /**
   * Arm a ROUTE-06 Router PRESET placement (ROUTE-06). Both presets place the ONE
   * `Node::Router` engine and differ ONLY by the seeded `Port.medium`: HTTP Router
   * = Electrical (1), the Router preset = Mechanical (0). Placement emits `Place{ROUTER}`
   * and, once the host echoes the minted node, the port-seeding sequence
   * (`RemovePort` the bare catalog ports, then `AddPort` the preset legs at
   * `medium`) — the exact command shape `GridSession::place_router_preset` runs
   * (plan 36-03), never a new machine_kind or forked routing. The preset is In plus
   * `ROUTER_OUT_ARITY` Outs, WIDENED FROM 1-in/2-out by plan 65-05; the legs are
   * DERIVED from `catalogEntry(ROUTER).ports`, so the count appears nowhere here as
   * a literal and this sentence must not restate it either. Reuses the
   * echo-then-follow-up sequencing (a same-batch command can never reference a
   * same-batch mint — RESEARCH Finding 4).
   */
  beginRouterPreset(medium: number): void;
  /**
   * Arm DrawBelt-only draw mode — called by the palette's Belt tool. A belt is
   * DRAWN (click-drag an orthogonal path → one `DrawBelt`) and DOCKED (`Dock`),
   * never PLACED: the core rejects `Place{BELT}` (17-02), so belt draw is its own
   * mode rather than a `Place(BELT)` sentinel routed through `beginPlacement`.
   */
  armBeltDraw(): void;
  /**
   * Arm DrawWire-only draw mode - called by the palette's Wire tool (WIRE-02).
   * A wire is DRAWN nub to nub: press an electrical `Role::Out` nub, drag (the
   * orthogonal corridor the landed cable will take is previewed live through the
   * byte-pinned `wireRoute` mirror), release on an `Role::In` nub, and exactly ONE
   * `DrawWire{from_node, from_port, to_node, to_port}` goes out. The user chooses
   * WHICH ports connect; the host auto-routes the L between them, so there is no
   * corridor to author and nothing to store. Same arming contract as
   * `armBeltDraw`: re-click toggles off, the first Esc drops a held source and keeps
   * the tool and the next one disarms (D-11), right-click cancels the in-flight drag,
   * the middle button pans and keeps both, exactly one tool armed at a time (IX-03), and the tool
   * stays armed after a wire lands so a user can draw several.
   */
  armWireDraw(): void;
  /** The currently selected node handle, or null. */
  selectedId(): number | null;
  /**
   * Issue EXACTLY ONE logged `Delete` for `handle` and clear selection. This is
   * the SINGLE emit path every delete resolves into — the no-items keyboard
   * branch AND each dialog outcome — so "exactly one logged Delete" holds for
   * every path (SC5). The node leaves the canvas only when the host echoes the
   * removal (no optimistic local write).
   */
  commitDelete(handle: number): void;
  /**
   * The SHARED delete-decision path (IX-04, T-30-01): run the SAME in-flight-
   * items guard as the keyboard Delete branch, then resolve into exactly one
   * outcome — defer to the UI guard (`onDeleteWithItems`) when the machine still
   * carries in-flight items, otherwise a single `commitDelete`. The coming DOM
   * delete button (30-06) routes through THIS so the keyboard and the button
   * share ONE decision path (no duplicated guard logic in React); SC5's "exactly
   * one logged Delete per delete" holds either way.
   */
  requestDelete(handle: number): void;
  /**
   * BELT-02 (phase 89, D-07): the SAME decision path for a BELT. Counts the items on that belt
   * alone; with items on it and the guard wired, defer to the guard (`onDeleteWithItems` with
   * kind `belt` and the belt itself as the one belt to drain) and send nothing; otherwise one
   * `commitDelete`. The Delete key on a selected belt and the belt panel's `Delete belt` button
   * both route through this, so a belt has one guarded delete path, as a machine does.
   */
  requestBeltDelete(handle: number): void;
  /**
   * Hand the gesture layer the LIVE stranded-dock ring set (CONNECT-02).
   *
   * WHAT IT CARRIES. One record per stranded event: the orphaned belt's render
   * handle, the event's OWN recorded `BeltEnd` (never assumed - `ev.end` comes
   * straight off `StrandedDock`), and the world point of the ORPHANED BELT END
   * only. The vacated-port point is deliberately NOT carried: a machine's port
   * does not move by being dragged, only a belt's dangling tile end can be
   * re-aimed, which is why 67-UI-SPEC 4.2 makes only the belt end a drag source.
   * The vacated-port ring stays a passive marker (and doubles, for free, as the
   * hint for where to drop the drag).
   *
   * WHEN APP CALLS IT. From the packet handler, in the SAME two places the ring
   * PAINT is driven: alongside `showAlertRings` when a packet stranded something,
   * and with an EMPTY array alongside `clearAlertRings` on the structural
   * edit-clear. Mirroring the paint exactly is the point - a set that only ever
   * grew would keep a dead ring pressable after the paint had gone.
   *
   * WHAT IT DOES NOT DO. It writes NO scene state and issues NO command; the
   * records are display/hit-test input with the same lifetime as the paint, in
   * the register {@link refreshSelection} already established for an App-driven,
   * display-only hand-off.
   */
  setStrandedRings(rings: readonly StrandedRing[]): void;
  /**
   * Clear the ephemeral selection UNCONDITIONALLY (WR-01 / UNDO-06). App calls
   * this after applying a `full:true` keyframe. On an undo/redo/load reset the
   * host rebuilds its dense render-handle table from 0, so a handle can be REUSED
   * for a DIFFERENT physical node — a stale selected handle would then silently
   * point at the wrong node and a subsequent Delete would hit it. Because
   * selection is frontend-ephemeral and never host-echoed, clearing it on every
   * keyframe is cheap and safe, and closes the wrong-target Delete. (Supersedes
   * the old clear-if-missing `reconcileSelection`, which did NOT detect handle
   * REUSE, only absence.)
   */
  clearSelection(): void;
  /**
   * FAIL-01 (phase 90, D-12): the host's sim loop has ended. End every gesture in flight with
   * nothing sent, put an armed tool away and clear the selection (which closes its panel through
   * `onSelect(null)` / `onSelectBelt(null)`), as an Escape would, all at once. App calls it at
   * the stop; `isSimStopped` keeps it that way after.
   */
  standDown(): void;
  /**
   * Re-derive the selection affordances after the SELECTED element is
   * re-emitted by the host (WR-01/WR-02). A Rotate echo re-emits the node
   * with its new rot: the statics rebuild, but the selection outline, corner
   * ticks, and rotate-handle center were drawn at select time — for a
   * non-square footprint the effective box swaps, so the drawn handle would
   * float where `rotateHandleHit` no longer looks. A Dock echo re-emits the
   * belt with its new dock: `beltHandlePoints` then resolves that end to the
   * nub anchor (~26.5px from the tile center — beyond the 12px hit radius),
   * so the drawn handle circle and the lazily-recomputed `hitHandle` target
   * would diverge until the next selection change. App calls this from
   * onPacket (non-full packets only; a full keyframe takes `clearSelection`
   * instead) with the packet's placed node ids and emitted belt ids.
   * Display-only: no command, no scene write, and a no-op unless the current
   * selection is among the re-emitted ids.
   */
  refreshSelection(
    placedNodeIds: readonly number[],
    emittedBeltIds: readonly number[],
  ): void;
  /**
   * What this controller is still waiting on (phase 88 review, IN-05): pending Places, held
   * belts and sent Docks whose verdicts have not come. A read with no effect, for tests and
   * diagnostics.
   */
  waiting(): { placements: number; belts: number; docks: number };
  /** Detach all listeners + clear affordances. */
  destroy(): void;
}

/**
 * A belt is docked to a node iff one of its per-end `docks` names that node's
 * render handle (WR-02). Phase 16 replaced the old endpoint-cell match with the
 * host-authoritative link-graph docks (`belt.docks[].node` carries the docked
 * machine handle directly), so this is now an exact handle equality rather than
 * an inferred cell coincidence — strictly more precise than the old
 * `from`/`to`-equals-footprint-cell test. Pure read off the echoed scene — no
 * float, no mutation.
 */
function beltDockedToNode(belt: BeltView, nodeId: number): boolean {
  return belt.docks.some((d) => d.node === nodeId);
}

/**
 * The in-flight item count "for" a selected machine handle = the sum of items on
 * belts docked to its footprint, plus the docked belt ids (so App can poll those
 * exact counts via window.__fabrico while draining). A read-only probe over the
 * echoed scene; the WebGL item layer is read only as a COUNT (belt.items.length),
 * never per-item.
 */
function inFlightForNode(
  scene: SceneState,
  nodeId: number,
): { count: number; beltIds: number[] } {
  const node = scene.nodes.get(nodeId);
  if (!node) {
    return { count: 0, beltIds: [] };
  }
  let count = 0;
  const beltIds: number[] = [];
  for (const belt of scene.belts.values()) {
    if (beltDockedToNode(belt, nodeId)) {
      count += belt.items.length;
      beltIds.push(belt.id);
    }
  }
  return { count, beltIds };
}

/**
 * Belt tile hit-test: the belt routing a tile through `(cx, cy)`, or undefined.
 * The same tile-membership scan shape as the belt loop in `ghost.ts`'s
 * occupancy probe — pure read
 * off the echoed scene (RESEARCH Finding 6: belts are NOT in `scene.nodes`, so
 * a belt tile press would otherwise read as empty floor and pan the camera).
 */
function beltAtCell(
  scene: SceneState,
  cx: number,
  cy: number,
): BeltView | undefined {
  for (const belt of scene.belts.values()) {
    for (const t of belt.tiles) {
      if (t.cell_x === cx && t.cell_y === cy) {
        return belt;
      }
    }
  }
  return undefined;
}

/**
 * THE OCCUPIED-DOORSTEP TERM (phase 74.1-04, UI-SPEC 1.3 and 3.2 item 3): true when the
 * floor cell `port` feeds ({@link doorstepCell}) holds a machine body or a belt tile.
 * The pair is the one occupancy reading this file uses for a drawn cell, so "occupied"
 * means here what it means to the path preview.
 *
 * TWO READERS, ONE TERM: the Belt-armed ring set (`dockTargetPoints`) and the press
 * lookup (`doorstepPressHit`). A ring is painted exactly where a press can start a
 * connected draw, and neither offers a draw that would start on top of something.
 *
 * QUEUED GESTURES COUNT (phase 88, plan 88-07, BELT-06, D-09). The cell is read through
 * `cellOccupied`, the one occupancy definition, so a held belt's tiles (a draw already sent
 * off this doorstep on a paused board) take it; and the source itself is taken when a queued
 * link will use it (`doorstepTaken`: a held belt's Tail dock or a queued Dock naming
 * `owner`'s `port`). A second draw from a held belt's doorstep is red and sends nothing, as
 * the host would refuse it on Play.
 */
function doorstepOccupied(scene: SceneState, owner: number, port: PortView): boolean {
  const [cx, cy] = doorstepCell(port);
  return (
    cellOccupied(scene, cx, cy) || (scene.queuedClaims?.doorstepTaken(owner, port.index, scene.generation) ?? false)
  );
}

/**
 * THE HEAD-TAKEN TERM (hoisted out of `dockTargetPoints` in phase 74.1-11, review WR-04):
 * true when `belt`'s HEAD already carries a Head dock. A Head is a single `(node, port)`
 * with at most one OUTGOING link, and LINK-06's occupancy guard refuses the second. A
 * TAIL is never "taken": any number of links may target it, which is exactly what makes
 * a fan-in constructible (D-08), so a Tail is offered however many upstreams it has.
 *
 * THREE READS, ONE TERM, beside {@link doorstepOccupied} for the same reason: the
 * Belt-armed ring set, the handle-drag drop set (both in `dockTargetPoints`) and the
 * press lookup (`doorstepPressHit`). Since the host narrowing (74.1-01) a Head may dock
 * SIDEWAYS to an In and leave its own doorstep free, so occupancy cannot carry this
 * claim, and a ring set and a press that each kept their own copy could drift apart
 * (T-63-14).
 *
 * A QUEUED LINK TAKES IT TOO (phase 88, plan 88-07, BELT-06, D-09): a Dock sent but not yet
 * folded that joins this Head (`queuedClaims.beltEndTaken`), so a second drag onto a belt end
 * a queued Dock names wears no accepting ring, as the host would refuse it on Play
 * (`BeltEndTaken`).
 */
function headTaken(belt: BeltView, scene: SceneState): boolean {
  return (
    belt.docks.some((d) => d.end === 'Head') ||
    (scene.queuedClaims?.beltEndTaken(belt.id, 'Head', scene.generation) ?? false)
  );
}

/**
 * THE HOST'S THIRD OCCUPANCY TERM, MIRRORED (plan 74.1-33, review round 4 WR-02): true when
 * some belt's TAIL dock already names `node`'s Out or Fault `port`, so a Tail dropped on it
 * is refused `PortOccupied` ("That output is already connected. Disconnect it first.").
 *
 * THE KEYSPACE IS THE DOCK RECORDS', NOT THE CATALOG'S. A Tail dock's `port` on the wire is
 * the host's LINK KEY (`render_packet.rs` `belt_docks` reads it straight off the link map),
 * which `command.rs` `dock_link_key` writes as:
 *   - an Out: its ORDINAL among the node's Outs (the Outs at a lower catalog index,
 *     counted), so a Router's second Out at catalog index 2 is key 1;
 *   - a Fault: the `FAULT_PORT` sentinel, for EVERY Fault the node declares, so a box with
 *     two Faults holds one Fault link and the second Fault reads taken once the first is
 *     drained.
 * The Tail arm's occupancy check is `source_occupied((node, link_port), (node, port))`, so
 * comparing the dock's `port` with this key is the host's own question; comparing it with
 * `port.index` would miss every Out past the first one that is not catalog-ordered first.
 * (`dockPort` in `protocol/ports.ts` reads the same keyspace back the other way.)
 *
 * A wire drawn from the same Out is the host's other half of that check
 * (`wire_from_port_exists`) and is not read here: no belt drag can reach a wired
 * Electrical Out, because `acceptsDock`'s medium term already refuses it.
 *
 * A QUEUED LINK TAKES IT TOO (phase 88, plan 88-07, D-09): a Tail Dock sent but not yet folded,
 * or a held belt drawn off this port, names it in the claims (by catalog index, the `port` a
 * Dock carries; for a Fault, any of the node's Faults, which share the one link key).
 */
function machineSourceTaken(scene: SceneState, node: NodeView, port: PortView): boolean {
  const belts = scene.belts;
  const claims = scene.queuedClaims;
  if (claims !== undefined) {
    if (port.role === PORT_ROLE.FAULT) {
      if (node.ports.some((p) => p.role === PORT_ROLE.FAULT && claims.doorstepTaken(node.id, p.index, scene.generation))) {
        return true;
      }
    } else if (port.role === PORT_ROLE.OUT && claims.doorstepTaken(node.id, port.index, scene.generation)) {
      return true;
    }
  }
  let key: number;
  if (port.role === PORT_ROLE.FAULT) {
    key = FAULT_PORT;
  } else if (port.role === PORT_ROLE.OUT) {
    key = node.ports.filter((p) => p.role === PORT_ROLE.OUT && p.index < port.index).length;
  } else {
    return false;
  }
  for (const b of belts.values()) {
    if (b.docks.some((d) => d.end === 'Tail' && d.node === node.id && d.port === key)) {
      return true;
    }
  }
  return false;
}

/**
 * THE END-TILE CONTAINMENT TERM (plan 74.1-15 for the press, factored out in plan 74.1-25
 * for the drop): true when the WORLD point `w` lies inside the tile of `tiles`' `end`.
 * Bounds are CLOSED, so a point on an edge two tiles share is inside both, and each reader
 * decides that case by its own rule (the press falls back to the radius; the drop ranks
 * accepting first, then nearest).
 *
 * TWO READERS, ONE TERM: `hitHandle` (which of MY ends did the press pick up) and
 * `updateDropCandidate` (which OTHER belt's end does the drop land on). The press and the
 * drop are the two halves of one gesture, and a hand that may let go anywhere on the tile
 * it could pick up from must meet the same edge in both; two copies of the bounds would be
 * the drift this file keeps recording.
 */
function inTile(tiles: TileView[], end: BeltEnd, w: { x: number; y: number }): boolean {
  const [cx, cy] = beltEndCell(tiles, end);
  return w.x >= cx * CELL && w.x <= (cx + 1) * CELL && w.y >= cy * CELL && w.y <= (cy + 1) * CELL;
}

/**
 * Echo-watch TTL in sim ticks (WR-03/WR-05). The gesture channel DOES carry a
 * typed verdict since Phase 64 (the reply oneshot on the envelope
 * `acquire_input` drains), and that verdict is what tells the USER why a command
 * was refused. It does NOT replace this backstop, and the two answer different
 * questions: a verdict says the command was REFUSED, while the echo says the
 * state actually MOVED. A command can be accepted and still never echo the shape
 * this watcher is waiting for. So without a TTL an unechoed command would leave
 * its watcher polling — and its affordance painted — forever.
 * If the sim advances this many ticks past the emit without the echo landing,
 * the watcher abandons that pending entry. Tick-based rather than wall-clock so
 * a PAUSED sim (tick frozen) never expires a pending echo prematurely.
 * 120 ticks = ~2s at the 60 ticks/sec target — far beyond any real echo
 * latency (echoes land within a tick or two).
 *
 * Phase 88: a pending Place now ends on its own verdict (D-06), so for a Place this is only
 * the fallback for a verdict that was lost, and it and the pending-rotation record count only
 * ticks run while playing (D-07): a paused board still drains ticks with input held, so a
 * frozen tick is not what keeps a queued edit alive; `onResume` restarts the count instead.
 */
// ONE FIGURE (phase 88 review, IN-06): the literal is `queuedClaims.ts` `CLAIM_TTL_TICKS`, so a
// queued claim and the pending entry it shadows cannot fall out of step.
const ECHO_TTL_TICKS = CLAIM_TTL_TICKS;

/**
 * The belt draw accumulator's per-sample walk bound (plan 74-14), in cells.
 *
 * A pointer sample whose segment crosses more cells than this walks NOTHING: the
 * sample is discarded and the draw pauses until the next one.
 *
 * WHAT THE BOUND BUYS, and this list was rewritten on 2026-09-10 (WR-02) because the
 * two reasons that stood here were both MEASURED FALSE by the phase review:
 *
 * 1. BOUNDED WORK PER SAMPLE. The walk is O(cells crossed) and runs at pointer rate,
 *    so a sample the browser hands us from off-canvas or off-grid cannot turn one
 *    move event into an unbounded loop.
 * 2. LOOP TERMINATION. The walk terminates structurally (it runs exactly the Manhattan
 *    distance this bound is checked against before the loop; see `walkCellsBetween`'s
 *    docblock). Its in-loop check against this constant is belt-and-braces only.
 *
 * WHAT IT DOES NOT DO, recorded so the next reader tuning this number weighs the
 * right things:
 *
 * - It is NOT what stops a long run being PAINTED. The accumulator's manhattan test
 *   (branch d of the per-cell rule) already makes that impossible: no cell further
 *   than 1 from the head can ever be appended.
 * - It is NOT what keeps the legacy rig's port-to-port fixture byte-identical. The
 *   review raised the constant to 1000 and ran the suite: the emitted bytes were
 *   UNCHANGED and the only failing assertion was the preview-CALL COUNT. The reason
 *   is geometric - that 263-cell walk from cell (96,176) to (4,5) reaches the head's
 *   neighbourhood only at its very last cell, and that is the cell the next sample
 *   would have pushed anyway. What the bound decides for that fixture is whether the
 *   sample is walked at all, which is what `an over-long sample walks nothing, so the
 *   preview is not touched` pins.
 *
 * The trade, recorded honestly rather than left implied: a single sample that crosses
 * more cells than this is dropped ENTIRELY, and because `drawnFrom` still advances to
 * that sample the segment is never retried - so the head freezes where it was until
 * the pointer comes back adjacent to it. The larger this number, the harder that is
 * to provoke, which is why the value is DERIVED below rather than picked.
 */
/**
 * The largest single-sample pointer displacement, in SCREEN px, that the walk will
 * still follow. Set once here because a cell count is the wrong unit to reason about
 * a mouse in: what a hand can do between two 60Hz samples is a distance on the glass,
 * and the same cell count is a different distance at every zoom.
 *
 * 2048 px is beyond a plausible single sample on any display this ships to (it is
 * more than a full 1080p width) while still being trivial work to walk.
 */
const BELT_WALK_MAX_SCREEN_PX = 2048;
/**
 * The camera's zoom FLOOR, mirrored (`camera.ts` MIN_ZOOM). Mirrored rather than
 * imported: `input/` deliberately keeps out of `render/camera.ts`, which pulls
 * `pixi.js` in at module load - the same constraint `render/cableLane.ts:12` records
 * for itself. The mirror is not left on trust: `the walk bound's zoom floor mirrors
 * the camera's` in `gestures.test.ts` imports the real MIN_ZOOM and asserts equality,
 * so a camera that changes its clamp reddens here.
 */
const BELT_WALK_MIN_ZOOM = 0.25;
/**
 * The bound the walk actually enforces, in cells: the px budget above converted at the
 * LOOSEST zoom, where a cell is smallest on screen and a flick therefore crosses the
 * most of them.
 *
 * Raised from a flat 64 on 2026-09-10 (WR-06), because at 64 the bound meant sixteen
 * different things across the zoom range and only ever bit at one end of it. With
 * CELL = 32: at MAX_ZOOM 64 cells was 8192 px (unreachable), at zoom 1 it was 2048 px
 * (barely reachable), and at MIN_ZOOM it was 512 px - which one ordinary flick between
 * two samples clears. Zoomed out is exactly the state a user is in while drawing the
 * long belts this phase exists to make drawable, so the discard only ever fired in the
 * case it hurt most, and it froze the head for the rest of the drag when it did.
 *
 * Converting at the FLOOR rather than at the live scale is deliberate: a live-scale
 * bound would tighten to 16 cells at MAX_ZOOM, inventing a stall at high zoom that has
 * never existed. One constant, sized for the worst case, keeps the bound's meaning
 * ("more than 2048 px of pointer in one sample") true at every zoom it can bite at and
 * merely generous at the others.
 *
 * 256 cells. The legacy rig's 264-cell first sample is still over it, which is what
 * `an over-long sample walks nothing, so the preview is not touched` needs, and that
 * case asserts the margin against this constant by name rather than by coincidence.
 */
export const BELT_WALK_MAX_CELLS = Math.ceil(
  BELT_WALK_MAX_SCREEN_PX / (CELL * BELT_WALK_MIN_ZOOM),
);
/** The mirrored zoom floor, exposed ONLY so its test can compare it to the camera's. */
export const BELT_WALK_MIN_ZOOM_MIRROR = BELT_WALK_MIN_ZOOM;

/**
 * ROUTE-06 preset seeding - the EXACT legs `place_router_preset` (fabrico-command, plan
 * 36-03) runs after `Place{ROUTER}`: strip the bare catalog ports, then seed the preset
 * profile: the In and Outs at the preset medium, the Fault at Mechanical for both
 * presets (plan 85-05, D-22). The `side` rides for shape completeness only - the host
 * fold RE-SEATS every port deterministically by list position (the AddPort wire doc).
 *
 * These legs are DERIVED from the MACHINE_CATALOG entry (plan 65-05), not restated
 * beside it. Until 65-05 this was a hand-written three-element array holding one In and
 * TWO Outs, which stayed a plausible-looking mirror while the Rust catalog declared
 * three, so a browser-placed Router had nowhere to send a second branch. Deriving here
 * means the output count appears NOWHERE in the frontend as a literal.
 *
 * The caveat, stated rather than left to be discovered: this ties the legs to
 * `MACHINE_CATALOG`, a HAND-MAINTAINED mirror of the Rust catalog (see its own drift
 * docblock in decode.ts), not to `ROUTER_OUT_ARITY` itself. The check that closes THAT
 * gap is crates/fabrico-command/tests/ts_catalog_mirror.rs, which embeds decode.ts at
 * compile time and asserts this table's Router profile equals the Rust constant.
 */
const ROUTER_PRESET_PORT_LEGS: ReadonlyArray<{ role: number; side: number }> =
  catalogEntry(machine_kind.ROUTER).ports.map((p) => ({ role: p.role, side: p.side }));

/**
 * The preset seeding for a freshly-echoed Router `node`, as the ordered GridCommands the
 * gesture controller sends (plan 85-05 lifted this out of the controller unchanged, so a
 * live spec can put the shipped HTTP-preset legs on the real host now that no palette
 * row arms that preset). RemovePort the bare ports highest-index FIRST (so lower indices
 * stay valid as each folds, mirroring place_router_preset's index 1->0), then AddPort
 * the preset legs (the Fault at Mechanical, every other leg at `medium`), then the
 * preset's declared fallback. Every command
 * references the ECHOED handle - it exists now, so they ride the drain like the
 * post-echo Rotates (never a same-batch mint, Finding 4).
 */
export function routerPresetSeedCommands(
  node: Pick<NodeView, 'id' | 'ports'>,
  medium: number,
): GridCommand[] {
  const out: GridCommand[] = [];
  const indicesDesc = node.ports.map((p) => p.index).sort((a, b) => b - a);
  for (const index of indicesDesc) {
    out.push({ kind: 'RemovePort', node: node.id, index });
  }
  for (const leg of ROUTER_PRESET_PORT_LEGS) {
    // D-22 (plan 85-05): the Fault leg seeds at MECHANICAL for both presets, the In and
    // Outs at the preset `medium`. A Router's fault is an item it could not route, and
    // items ride belts. Seeded at the preset medium, the HTTP Router's fault nub was
    // Electrical: the Belt tool's doorstep press skips an Electrical port (the MEDIUM
    // term of `doorstepPressHit`) and the host refuses a belt docked on one, so it was
    // a nub nothing could attach to, confirmed on the real host before this line moved
    // (`e2e-live/16-router-presets.spec.ts`, the fault-nub leg). The Rust twin,
    // `router_preset_ports`, makes the same choice.
    const legMedium = leg.role === PORT_ROLE.FAULT ? MEDIUM_MECHANICAL : medium;
    out.push({ kind: 'AddPort', node: node.id, role: leg.role, side: leg.side, medium: legMedium });
  }
  // 73-06: THE PRESET DECLARES ITS OWN FALLBACK, and it must, because the loop
  // above just deleted the port the minted one named.
  //
  // A bare Router is minted with a `default` naming its CATALOG Out, routing key
  // 0. The RemovePort loop strips that very Out. Until 73-06 the fold left
  // `default` untouched, so the value silently survived the deletion of the port
  // it was written about and came to mean "the first PRESET Out" - a DIFFERENT
  // physical output. That is the silent-renumber defect UNDO-04 exists to close,
  // and `fold_remove_port` now clears a `default` that names the removed key.
  //
  // Which leaves this function owing a value it was previously inheriting by
  // accident. Without this line a palette Router would arrive with no fallback at
  // all, so an unmatched item would FAULT instead of leaving on output 1 - a
  // user-visible change nothing asked for. Ruled on 2026-09-05: a preset
  // that inherits a fallback from a port it then deletes is itself the defect, and
  // declaring it is honest while preserving the shipped behaviour.
  //
  // Routing key 0 is the first Out the loop above seeded, so this is the SAME
  // observable answer the app already gave, now said out loud. The table is empty
  // because a freshly placed Router has no rules, which is exactly what
  // `frontend/e2e-live/24-one-board-all-six.spec.ts` reads back from the panel.
  //
  // Its twin is `GridSession::place_router_preset` in
  // `crates/fabrico-command/src/command.rs`, the test/scenario seam. BOTH carry
  // this leg or the two would disagree about what a Router is.
  out.push({ kind: 'Configure', node: node.id, config: { kind: 'Router', routes: [], default: 0 } });
  return out;
}

export function createGestureController(deps: GestureDeps): GestureController {
  const { canvas, cam, overlay, getScene, sendInput } = deps;
  const ghost = createGhostController({ overlay, cam, getScene });

  // Canvas-relative point from a pointer event.
  const toLocal = (e: PointerEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // ---- placement (palette drag) ------------------------------------------
  let placementKind: number | null = null;
  // ROUTE-06 preset medium armed with a Router preset (null for a plain machine
  // placement). When set, the placement seeds the preset ports at this medium
  // once its Place echoes (see PendingPlacement.presetMedium / watchEcho).
  // Electrical (1) = HTTP Router, Mechanical (0) = the Router preset.
  let placementPresetMedium: number | null = null;
  // Pre-placement rotation (CTRL-03 / D-14): 0..3 CW quarter-turns applied to
  // the armed ghost. `Place` carries NO rotation (schema untouched) — the rot
  // lands as N post-echo Rotate commands (see PendingPlacement.rotCount).
  let placementRot = 0;
  // The latest onWinMove point while a placement is armed, so a keyboard 'r'
  // can re-render the ghost at the cursor without waiting for the next move.
  let lastMovePoint: { x: number; y: number; overCanvas: boolean } | null = null;
  // The pending Places (WR-03 / WR-A lifecycle, keyed by gesture since phase 88): ONE entry
  // per sent Place whose host answer has not ended it, each carrying the gesture id its send
  // returned, its OWN cell, its queued Rotate count and its preset seeding. A rapid rotated
  // repeat-placement burst (IX-06) can send several Places before any is answered; each
  // keeps its own follow-ups and ends on its own verdict (D-06). The Rotates ride after the
  // accept and the packet that shows the minted handle (never a synchronous same-tick batch:
  // a same-batch command can never reference a same-batch mint, RESEARCH Finding 4).
  interface PendingPlacement {
    /**
     * The gesture id the send seam returned for this Place (phase 88, D-06). The host's
     * verdict names it back as `seq`, and it is the ONLY way an answer is matched to this
     * entry. Until phase 88 the client guessed which node a Place minted from the cell, the
     * kind, the node that covered the cell at the drop and emit order; one sequence (a
     * Delete of the blocker queued ahead of two drops on its cell) could not be told apart
     * that way, and the refused Place's Rotate turned the Source the user dropped unturned
     * (WORK-04, `a_queued_delete_then_two_drops_turns_nothing`).
     */
    gestureId: number;
    cell: CellCoord;
    /** The placed machine's kind byte, the `kind_byte` of the Place this entry watches. */
    kind: number;
    /** The footprint the waiting shimmer is painted at (rot-0 dims plus the armed rot). */
    dims: { w: number; h: number; rot: number };
    /** Queued CW Rotates to send once this Place's accept and packet are both in (0 = none). */
    rotCount: number;
    /**
     * The fallback anchor (phase 88, D-07): the tick at the send, or the tick the sim last
     * resumed at (`onResume`). Counted only while playing, so a pause never ends an entry.
     */
    emitTick: number;
    /**
     * ROUTE-06: when set, seed the Router preset ports at this medium once the accept and
     * its packet are in (strip the bare catalog ports, then AddPort the preset legs). Null
     * for a plain machine placement.
     *
     * The preset is In plus `ROUTER_OUT_ARITY` Outs, WIDENED FROM the 1-in/2-out set this
     * doc described until plan 65-05. `ROUTER_PRESET_PORT_LEGS` derives the legs from
     * `catalogEntry(ROUTER).ports`, so the number is not written here and must not be
     * reintroduced.
     */
    presetMedium?: number | null;
    /**
     * The entry's follow-ups were given up (refuter round after plan 76-10, kept by phase 88
     * D-08): arming a tool drops every queued Rotate, preset seeding and label focus request,
     * but the Place itself is already on the wire and the host still answers it, so the
     * entry stays until its verdict ends it, with nothing left to send. An abandoned Label
     * whose accept arrives is never selected and takes no focus.
     */
    abandoned: boolean;
    /**
     * The host's accept, once heard (phase 88, D-06): the handle the Place minted and the
     * generation of the handle table it belongs to. The entry then waits for a packet of
     * that generation holding the handle, and sends its follow-ups addressed to
     * `(generation, handle)`; or a keyframe of a higher generation (an Undo folded in
     * between) comes first, and they go to the machine on its anchor in that newest table
     * (T-88-25).
     */
    accepted: { generation: number; handle: number } | null;
  }
  let pendingPlacements: PendingPlacement[] = [];
  /**
   * The gesture id of the pending Place whose waiting shimmer the overlay's ONE shimmer slot
   * shows, or null when it shows none (phase 88, D-10, research Pitfall 9). An entry that
   * ends clears the slot only when the slot shows that entry, then repaints the newest live
   * entry's shimmer, so a refusal never wipes another pending Place's mark.
   */
  let shimmerOwner: number | null = null;
  /**
   * The generation of the newest swap keyframe (`onSwap`), -1 before any (phase 88,
   * T-88-11). An accept written in an older table than this was written on a replaced board:
   * the host discards anything stamped below it, and naming its belt or machines again in a
   * newer table would aim at the loaded board, so such an entry ends with nothing sent.
   */
  let swapGeneration = -1;
  /**
   * The generation below which an accept was written on a replaced board (T-88-11): the
   * newer of this page's own swap (`onSwap`) and the scene's swap floor, which the host puts
   * on every packet so a swap this page did not ask for counts too (T-88-11 re-audit).
   */
  const floorOf = (scene: SceneState): number => Math.max(swapGeneration, scene.swapFloor);
  let echoRaf = 0;

  // ---- draw-belt (palette Belt tool armed) -------------------------------
  // The Belt palette entry arms this mode via its OWN `armBeltDraw()` entry point
  // (NOT a `Place(BELT)` sentinel through beginPlacement — the core rejects
  // Place{BELT}, 17-02). A belt is DRAWN, never Placed. While armed, pan is
  // suspended; a click-drag accumulates orthogonally-adjacent cells; the live
  // preview runs the golden-pinned route() (build-blue legal / red illegal);
  // release on a legal path emits exactly ONE DrawBelt{cells}; an illegal path
  // emits NOTHING. Esc / right-click disarm.
  let beltArmed = false;
  let drawnCells: [number, number][] | null = null;
  /**
   * The PREVIOUS pointer sample of the live draw, in CANVAS-LOCAL SCREEN PX, so the
   * accumulator can walk the cells the segment between two samples crossed (74-14).
   * Null exactly when `drawnCells` is null.
   *
   * SCREEN px rather than world, and this is the one decision here a later reader is
   * most likely to tidy into a bug. `camera.ts:263-266` is wheel branch 3, the
   * trackpad two-finger pan, and it mutates `container.x/y` with NO `panEnabled`
   * check - so the camera CAN move between two pointer samples while a tool is
   * armed. With a WORLD anchor, a stationary pointer plus a three-cell trackpad pan
   * would paint three cells nobody swept. With a SCREEN anchor converted through the
   * CURRENT camera at both ends, the same event yields a zero-length segment:
   * nothing appends, the draw simply pauses, and no geometry is invented.
   *
   * HONEST LIMIT: no test in this repository can see that difference, because
   * nothing in either harness pans the camera mid-draw. The decision rests on the
   * reading of `camera.ts:263-266` and is filed as its own WINDOWS row.
   *
   * WHERE THE SAFETY ACTUALLY LIVES (IN-01, recorded 2026-09-10 so a later reader
   * does not mistake one half of this for the other). This field is READ at exactly
   * one place, `const from = drawnFrom ?? p`, inside `if (drawnCells)`. `drawnCells`
   * becomes non-null at exactly two sites - the nub seed and the plain cell seed -
   * and both set `drawnFrom` in the very next statement. So the load-bearing half is
   * the SEEDS: dropping either one kills 3 and 2 tests respectively. The four
   * `drawnFrom = null` lines are belt-and-braces (dropping the one in `disarmBelt`
   * changes no test), and the `?? p` fallback is UNREACHABLE. Do not "fix" that
   * fallback into something with different behaviour, and do not read the nulls as
   * the mechanism that makes the invariant hold.
   */
  let drawnFrom: { x: number; y: number } | null = null;
  // Port-to-port draw (D-12, CTRL-02): a press on an Out/Fault nub records the
  // SOURCE dock for the belt's Tail end. Keyspace discipline (the one place it
  // is easy to get backwards): the press cell is tiles[0] = the TAIL end
  // (admit) and docks to Out(1)|Fault(2); the release cell is tiles[last] =
  // the HEAD end (deliver) and docks to In(0). CONTEXT D-12's "head dock"
  // phrasing is drag-mental-model naming; this WIRE encoding is authoritative.
  let startDock: { node: number; portIndex: number } | null = null;
  // THE TAIL SEAM'S FEED (phase 74.1 plan 08): the flow `Dir` out of the pressed source,
  // recorded beside `startDock` and cleared wherever it is cleared. It is the port's
  // SIDE, because a machine Out or Fault pushes items along its side and a belt Head's
  // side (from `beltEndPort`) is its travel; `Side` and `Dir` share N=0 E=1 S=2 W=3.
  // Null when no source was pressed, or when the source is Electrical (the host refuses
  // that Tail dock as MediumMismatch, so no corner will ship). The preview reads it and
  // nothing else does: no command carries it.
  let startFeed: number | null = null;
  /**
   * THE REVERSED DRAW (phase 89, D-02, BELT-01): the free Mechanical In whose DOORSTEP the
   * press resolved to, or null. A belt pressed on an input flows INTO that input: the drawn
   * cells run from the pressed doorstep to the hand, and the release sends them REVERSED, so
   * the pressed doorstep is the belt's HEAD tile and docks the Head to this In, and the hand
   * end is the TAIL, docked to the Out or Fault the hand is on (`committedDraw`). Recorded
   * beside `startDock` and cleared wherever it is cleared; the two are never both set, because
   * the In lookup runs only when the source lookup missed (UI-SPEC A10). `port` is the In as
   * the scene had it at the press, so the Head seam's drain is `oppositeSide(port.side)`.
   */
  let startIn: { node: number; port: PortView } | null = null;
  // The WORLD point of the latest belt-draw pointer sample (the press, then each move),
  // so the preview can ask the release's own question (`committedDraw`) about the
  // pointer the release would see. Read by the preview only.
  let beltPointer: { x: number; y: number } | null = null;

  // Wire draw (WIRE-02, plan 66-01, the palette Wire tool). A strictly SIMPLER
  // sibling of the belt draw: no per-cell accumulation, no adjacency filter, no
  // occupancy check (a wire claims no cells) and NO echo-watched follow-up Dock -
  // a DrawWire names two EXISTING node handles and mints one wire in one command.
  // Press an electrical Out nub, drag (the orthogonal corridor the landed cable
  // will take is previewed live), release on an In nub, one DrawWire.
  let wireArmed = false;
  // The pressed SOURCE terminal. `cell` and `side` are the port's OWN world cell
  // and outward side, which is what `wireRoute` wants - see the seed note in the
  // onCanvasDown wire branch, where getting this wrong is a one-cell-per-end
  // divergence between the ghost corridor and the landed cable.
  // `medium` rides along because the CORRIDOR COLOUR is a prediction of the host's
  // answer and the host reads BOTH endpoints (command.rs step 5). It is read by the
  // preview and by nothing else: no emission anywhere is conditional on it.
  let wireSource:
    | {
        node: number;
        portIndex: number;
        cell: [number, number];
        side: number;
        medium: number;
      }
    | null = null;

  /**
   * THE PATH VERDICT AND THE CELL THE HOST WILL BLAME (phase 89, plan 89-09, D-12, D-13, UI-SPEC
   * 6.1 and 6.2). For the cells a release would send (walk order, TAIL FIRST), whether the host
   * would accept the path, and when it would not, the ONE cell its first failing check is about,
   * in the host's own order (`command.rs` DrawBelt arm): the route (a path that crosses itself:
   * the first drawn cell it revisits; a non-adjacent step, which the walk never makes: the cell
   * after the gap), then the length (more than {@link MAX_BELT_TILES} tiles: the first tile past
   * the cap), then each routed tile in path order, its bounds first (a tile outside
   * {@link GRID_MIN}..{@link GRID_MAX} on either axis) and then its occupancy (a tile on a
   * machine, a label, a belt or a queued claim). So the flash a release fires and the sentence
   * the host sends back name the same fault (A16). Empty cells are no path and blame no cell.
   * The one evaluator: the preview (`evalBeltPath`), the in-nub append guard (`beltPathLegal`)
   * and the release all read it.
   */
  type PathVerdict = { legal: true } | { legal: false; blame: CellCoord | null };
  const beltPathVerdict = (cells: readonly [number, number][]): PathVerdict => {
    if (cells.length === 0) {
      return { legal: false, blame: null };
    }
    const r = route(cells);
    if (!r.ok) {
      return { legal: false, blame: routeBlame(cells) };
    }
    if (r.tiles.length > MAX_BELT_TILES) {
      const past = r.tiles[MAX_BELT_TILES];
      return { legal: false, blame: { cx: past.cell_x, cy: past.cell_y } };
    }
    const scene = getScene();
    for (const t of r.tiles) {
      const off = t.cell_x < GRID_MIN || t.cell_x > GRID_MAX || t.cell_y < GRID_MIN || t.cell_y > GRID_MAX;
      if (off || cellOccupied(scene, t.cell_x, t.cell_y)) {
        return { legal: false, blame: { cx: t.cell_x, cy: t.cell_y } };
      }
    }
    return { legal: true };
  };
  /** The cell a refused route is about: the first revisit, else the first cell after a gap. */
  const routeBlame = (cells: readonly [number, number][]): CellCoord | null => {
    const seen = new Set<string>();
    for (const [x, y] of cells) {
      const key = `${x},${y}`;
      if (seen.has(key)) {
        return { cx: x, cy: y };
      }
      seen.add(key);
    }
    for (let i = 1; i < cells.length; i++) {
      if (Math.abs(cells[i][0] - cells[i - 1][0]) + Math.abs(cells[i][1] - cells[i - 1][1]) !== 1) {
        return { cx: cells[i][0], cy: cells[i][1] };
      }
    }
    return null;
  };

  // Route `cells` and render the preview build-blue (legal) or red (any failure of
  // `beltPathVerdict`: the route, the length cap, or a tile off the grid or on an occupied
  // cell), returning whether the path is legal. The preview's legality is the host's (D-12,
  // WINDOWS 251): until plan 89-09 it read only the route and the occupancy, so a run past the
  // grid edge or over the length cap was drawn blue and then refused.
  //
  // THE PREDICTION PICKS WHAT TO SEND AND WHERE TO FLASH, NEVER WHETHER (phase 89, plan 89-09,
  // D-13, FAIL-02). Until this plan the belt release was the last gesture the prediction
  // decided for: phase 64's D-09 kept one suppression here, so an illegal path (one that
  // crossed a machine, a label or itself, or a press just inside a machine's edge, whose seed
  // is the machine's own cell) emitted NOTHING, and the user saw a red corridor vanish with
  // no word. Its stated reason, that a failed route() has no tiles to encode, was never true:
  // the wire carries the raw cells, and the host answers a refused route with
  // `RouteSelfCrossing`. The rule that held everywhere else now holds for the belt too: WHAT
  // THE PLAYER SEES IS WHAT THE HOST IS ASKED, AND THE HOST'S ANSWER IS WHAT HAPPENS. Every
  // non-empty release is sent; an illegal one carries no claim, no follow-up, no held picture
  // and no predicted seam, and the host's sentence says why (`onWinUp`).
  //
  // IT PAINTS A COMMITTED ANSWER, NOT THE RAW DRAWN CELLS (phase 89, plan 89-05, research
  // Pitfall 5): `c` is `committedDraw`'s answer for the pointer, the cells the release would
  // send (reversed for a draw pressed on an input, trimmed and appended at the dot), and the
  // feed and drain the two end tiles are re-kinded with. The preview and the release paint
  // the same answer, so the ghost the hand saw is the belt the host is asked for.
  const evalBeltPath = (c: CommittedDraw): boolean => {
    shownKey = committedKey(c);
    const cells = c.cells;
    if (cells.length === 0) {
      overlay.clearBeltPreview();
      return false;
    }
    const r = route(cells);
    if (!r.ok) {
      overlay.showBeltPreview([], false); // typed reject (Empty/NonAdjacent/SelfCrossing)
      return false;
    }
    const legal = beltPathVerdict(cells).legal;
    // The kinds are the ones the host will SHIP (74.1-08), legality is the cells':
    // `seamEndTiles` re-kinds only the two end tiles and touches no cell, so the verdict
    // above and `beltPathLegal` below read the same cells either way.
    overlay.showBeltPreview(seamEndTiles(r.tiles, c.feed === null ? [] : [c.feed], c.drain), legal);
    return legal;
  };
  const refreshBeltPreview = (): boolean =>
    drawnCells ? evalBeltPath(committedDraw(drawnCells, beltPointer)) : false;

  /**
   * WHAT A RELEASE WOULD COMMIT, as plain data (phase 89, plan 89-05). `cells` are the cells
   * the DrawBelt carries, TAIL FIRST (the wire's order); `tail` and `head` are the follow-up
   * Docks of the two ends (keyspace note at `startDock`: tiles[0] is the Tail, tiles[last]
   * the Head); `feed` and `drain` re-kind the two end tiles the way the host will draw them
   * once those Docks land (`seam.ts` `seamEndTiles`, 74.1-08); `flash` is the dot cell of a
   * last-resort Head the mirror refuses, which a LEGAL release flashes (WR-02, UI-SPEC A23).
   */
  interface CommittedDraw {
    cells: [number, number][];
    tail: { node: number; portIndex: number } | null;
    feed: number | null;
    head: { node: number; portIndex: number } | null;
    drain: number | null;
    flash: CellCoord | null;
  }
  /** One string per answer, so a sample that changes no cell can still tell it changed. */
  const committedKey = (c: CommittedDraw): string =>
    JSON.stringify([c.cells, c.tail, c.feed, c.head, c.drain]);
  /** The answer the last preview call painted (see `answerMoved`). */
  let shownKey = '';

  /**
   * THE ONE ANSWER TO "WHAT DOES THIS RELEASE COMMIT" (phase 89, plan 89-05, D-02, research
   * Pitfall 5): for the drawn cells (walk order, press first) and a pointer WORLD point, the
   * cells the DrawBelt carries and the Docks that follow it. Two callers, the preview
   * (`refreshBeltPreview`, `answerMoved`) and the release (`onWinUp`), so the ghost and the
   * commit cannot disagree; a second copy of any part of it is the drift class this file
   * records twice already.
   *
   * A FORWARD DRAW (pressed on an Out, a Fault, a free belt Head, or floor): the Tail docked to
   * what the press recorded (`startDock`); the Head, and the cells, decided at the pointer by
   * {@link headInAt}: an In nub or a belt Tail end in reach, the cells trimmed of that target's
   * own cells and appended with its doorstep (D-03, D-06), ranked accepting first, then the one
   * auto-dock target the head faces, then the nearest refused hit (D-04).
   *
   * A REVERSED DRAW (pressed on a free Mechanical In's doorstep, `startIn`): the cells
   * REVERSED, so the pressed doorstep is the Head tile, docked to that In; the hand end is the
   * Tail, docked to what {@link tailOutAt} finds at the pointer (an Out, a Fault or a free
   * belt Head whose doorstep is the hand's cell, else an Out or Fault dot in reach), or left
   * free on floor. Released on floor, the belt still flows into the pressed In.
   */
  const committedDraw = (drawn: [number, number][], w: { x: number; y: number } | null): CommittedDraw => {
    if (startIn !== null) {
      const tailHit = tailOutAt(drawn, w);
      const cells: [number, number][] = [...(tailHit?.path ?? drawn)].reverse();
      const r = route(cells);
      // The pressed In judged by the host mirror on the path this release commits: its
      // doorstep is the Head tile by construction (the press seeded on it), so in practice
      // only a path that runs back into the In's own machine is refused, and that path is
      // red anyway. The Head dock is sent either way; the drain only re-kinds an accepted one.
      const headOk =
        r.ok &&
        acceptsDock(startIn.port, 'Head', beltEndCell(r.tiles, 'Head'), beltEndOutward(r.tiles, 'Head'), MACHINE_TARGET);
      return {
        cells,
        tail: tailHit === null ? null : { node: tailHit.hit.handle, portIndex: tailHit.hit.port.index },
        feed: tailHit !== null && tailHit.accepts ? tailHit.hit.port.side : null,
        head: { node: startIn.node, portIndex: startIn.port.index },
        drain: headOk ? oppositeSide(startIn.port.side) : null,
        // The WHERE half of A23 for the reversed draw (review IN-B-04, UI-SPEC A22): a last-resort
        // Tail the mirror refuses flashes its dot's cell, as a forward draw's refused Head does.
        flash: tailHit !== null && !tailHit.accepts ? { cx: tailHit.hit.port.cell_x, cy: tailHit.hit.port.cell_y } : null,
      };
    }
    const tail = startDock;
    const feed = startDock === null ? null : startFeed;
    // The Head: an In nub or a belt Tail end in reach (trimmed, ranked), else the one auto-dock
    // target the routed head faces, else nothing. All of it is `headInAt`'s answer, read with
    // no pointer as "nothing in reach".
    const head = headInAt(drawn, w);
    if (head === null) {
      return { cells: drawn, tail, feed, head: null, drain: null, flash: null };
    }
    return { cells: head.path, tail, feed, head: head.target, drain: head.drain, flash: head.flash };
  };

  /**
   * Whether the answer {@link committedDraw} gives for the latest pointer sample differs from
   * the one last painted, for a sample that moved no cell. The answer can change with the
   * pointer alone (an In nub or an Out dot comes into or out of reach), so without this the
   * corner would appear one cell late or stay after the hand left the nub.
   */
  const answerMoved = (): boolean =>
    drawnCells !== null && committedKey(committedDraw(drawnCells, beltPointer)) !== shownKey;

  // Pure legality probe for a CANDIDATE path: the one verdict evalBeltPath renders
  // (`beltPathVerdict`), so the in-nub append guard (WR-09) can test a path WITHOUT touching
  // the preview overlay.
  const beltPathLegal = (cells: [number, number][]): boolean => beltPathVerdict(cells).legal;

  /**
   * The cells the SEGMENT between two pointer samples crossed, in crossing order
   * (plan 74-14). Amanatides-Woo grid traversal, run in CELL space through
   * `cam.screenToCellFrac` so the sub-cell position of both endpoints decides where
   * the segment crosses each column and row line.
   *
   * Contract the accumulator relies on: the list STARTS with the cell containing
   * `from`, ENDS with the cell containing `to`, and consecutive entries are
   * orthogonally adjacent BY CONSTRUCTION (one axis step per iteration). It never
   * contains a diagonal step, so a walked pair is always a legal belt step.
   *
   * THE TIE-BREAK, a fixed choice rather than an accident of float comparison: when
   * the segment crosses a column line and a row line at the SAME parameter (a
   * lattice corner, which the centre-to-centre diagonal of a 45 degree elbow does
   * exactly), step X FIRST. `a diagonal elbow sample draws the corner it swept` pins
   * it and nothing else does: that segment's expected bytes carry (3,2) as the middle
   * cell, and stepping Y first would carry (2,3).
   *
   * Returns an EMPTY list for a sample whose walk would exceed
   * `BELT_WALK_MAX_CELLS`, and for a non-finite coordinate.
   *
   * TERMINATION IS STRUCTURAL (rewritten in 74.1-11, review IN-01). Since the
   * per-axis end terms (74.1-05), every iteration moves exactly one axis one cell
   * TOWARD its end: x steps only while `cx !== ex`, y only while `cy !== ey`, and
   * `sx`/`sy` carry the sign of `ex - cx`/`ey - cy` because `floor` preserves order. No
   * axis can overshoot, so the loop runs exactly the Manhattan distance between the two
   * end cells, and that distance (plus the start cell) is already checked against
   * `BELT_WALK_MAX_CELLS` before the loop. Float drift in `tx`/`ty` can change WHICH
   * axis steps, never WHETHER the walk ends.
   *
   * The in-loop `out.length > BELT_WALK_MAX_CELLS` check is therefore unreachable and is
   * kept as BELT-AND-BRACES only: one comparison per cell against a future edit that
   * breaks the step rule. It is not the guard. History: until 2026-09-10 (WR-03) this
   * paragraph said the check made a NaN coordinate terminate, which was false (the
   * `Number.isFinite` guard returns first), and until 74.1-11 it called the check the
   * only thing between a float-drift stall and a hung pointer handler, which the
   * per-axis end terms made false.
   */
  const walkCellsBetween = (
    from: { x: number; y: number },
    to: { x: number; y: number },
  ): Array<[number, number]> => {
    const a = cam.screenToCellFrac(from.x, from.y);
    const b = cam.screenToCellFrac(to.x, to.y);
    if (
      !Number.isFinite(a.fx) ||
      !Number.isFinite(a.fy) ||
      !Number.isFinite(b.fx) ||
      !Number.isFinite(b.fy)
    ) {
      return [];
    }
    let cx = Math.floor(a.fx);
    let cy = Math.floor(a.fy);
    const ex = Math.floor(b.fx);
    const ey = Math.floor(b.fy);
    // The walk's CELL COUNT is exactly the manhattan distance between the two end
    // cells PLUS ONE (the start cell is in the list), so the bound can be checked
    // before a single iteration runs - and it has to be checked against the same
    // quantity the in-loop bound below checks, or the two disagree at the boundary.
    //
    // The `+ 1` was missing until 2026-09-10 (WR-01). Without it a manhattan of
    // exactly BELT_WALK_MAX_CELLS - a walk of MAX + 1 cells - was admitted here,
    // walked for MAX iterations, and then discarded by the in-loop bound anyway. Same
    // answer, MAX iterations of wasted work, and a constant whose effective bound was
    // one below the number written on it.
    if (Math.abs(ex - cx) + Math.abs(ey - cy) + 1 > BELT_WALK_MAX_CELLS) {
      return [];
    }
    const out: Array<[number, number]> = [[cx, cy]];
    const dx = b.fx - a.fx;
    const dy = b.fy - a.fy;
    // The step direction on each axis, with the ZERO case written out rather than
    // left to fall into the negative arm (IN-02, 2026-09-10). `dx > 0 ? 1 : -1`
    // answered -1 for a vertical segment, which was harmless ONLY because `tx` is
    // Infinity on the same condition four lines below and the x branch is therefore
    // never taken. Two lines encoding one invariant, sitting apart, with nothing
    // naming the coupling: an edit to the `tx` initialisation would have turned this
    // into a walk that stepped the wrong way. 0 is the honest answer and cannot be
    // misread.
    const sx = dx === 0 ? 0 : dx > 0 ? 1 : -1;
    const sy = dy === 0 ? 0 : dy > 0 ? 1 : -1;
    // Parameter (0..1 along the segment) at which the NEXT line on each axis is
    // crossed, and the parameter cost of one whole cell on that axis.
    let tx = dx === 0 ? Infinity : ((dx > 0 ? cx + 1 : cx) - a.fx) / dx;
    let ty = dy === 0 ? Infinity : ((dy > 0 ? cy + 1 : cy) - a.fy) / dy;
    const stepTx = dx === 0 ? Infinity : Math.abs(1 / dx);
    const stepTy = dy === 0 ? Infinity : Math.abs(1 / dy);
    while (cx !== ex || cy !== ey) {
      // An axis already on its end cell never steps again (74.1-05). Without the
      // `cx !== ex` term a segment moving -x and +y into a sample EXACTLY
      // on a lattice corner crosses its last x line and its last y line at the same
      // t = 1; x won the tie, stepped one cell PAST `ex` (x = 5.0 floors to 5, so cell 4
      // was never entered), and the walk could not come back: it ran to the bound below
      // and returned nothing, dropping the segment and freezing the path. On every other
      // input the next x line lies beyond t = 1 once `cx === ex`, so `tx <= ty` already
      // answered y and the terms change nothing. `cy === ey` is the y half: x wins an
      // exact tie, but an accumulated `ty` can round a hair under `tx` and send y past
      // `ey` the same way (found by search at MIN_ZOOM). Each term alone is pinned:
      // `a sample landing EXACTLY on a lattice corner while moving down-left ...` (x)
      // and `the mirror case: a long up-right sample onto a lattice corner ...` (y),
      // and the corner matrix (`cornerMatrix.test.ts`) sweeps both.
      if (cy === ey || (cx !== ex && tx <= ty)) {
        cx += sx;
        tx += stepTx;
      } else {
        cy += sy;
        ty += stepTy;
      }
      out.push([cx, cy]);
      if (out.length > BELT_WALK_MAX_CELLS) {
        return [];
      }
    }
    return out;
  };

  const disarmBelt = (): void => {
    beltArmed = false;
    drawnCells = null;
    drawnFrom = null;
    startDock = null;
    startFeed = null;
    startIn = null;
    beltPointer = null;
    // The drag preview is this tool's own gesture and dies with it. The held pictures of
    // committed belts live on their own surface (74.1-30) and are never cleared here:
    // their belts are still coming, and each picture ends on its own belt's echo.
    overlay.clearBeltPreview();
    overlay.clearNubRing();
    // D-07: the target rings appear with the arm and disappear with the disarm. They
    // own no TTL and read no clock, so THIS is the only thing that ever takes them
    // down, and it has to be here or the board keeps claiming a join can be made with
    // the Belt tool put away.
    overlay.clearDockTargets();
    cam.setPanEnabled(true);
    // IX-03: hand the cursor back to the camera and clear the armed report.
    canvas.style.cursor = '';
    deps.onArmedChange?.(null);
  };

  // Mirrors disarmBelt exactly (WIRE-02): drop the in-flight source, clear every
  // affordance the wire drag paints, restore pan + cursor, clear the armed report.
  const disarmWire = (): void => {
    wireArmed = false;
    wireSource = null;
    overlay.clearWireTargets();
    overlay.clearRoute();
    overlay.clearNubRing();
    cam.setPanEnabled(true);
    // IX-03: hand the cursor back to the camera and clear the armed report.
    canvas.style.cursor = '';
    deps.onArmedChange?.(null);
  };

  // The current placement footprint for the overlay affordances (pending
  // shimmer / reject flash): rot-0 catalog dims + the armed rot. The overlay
  // applies effectiveBox, exactly as showGhost/showSelection do (IX-05).
  const ghostDims = (
    kind: number,
    rot: number,
  ): { w: number; h: number; rot: number } => {
    const { w, h } = catalogEntry(kind);
    return { w, h, rot };
  };

  // ROUTE-06 preset seeding: the frames come from `routerPresetSeedCommands` (module
  // scope, below the controller's exports), sent in order after the accept and its packet,
  // each addressed with the accept's generation (phase 88), and quiet when the scene has
  // moved past it (T-88-25 re-audit).
  const seedRouterPreset = (
    node: Pick<NodeView, 'id' | 'ports'>,
    medium: number,
    generation: number,
    quiet: boolean,
  ): void => {
    for (const cmd of routerPresetSeedCommands(node, medium)) {
      sendInput(encodeGridCommand(cmd), quiet ? { generation, quiet } : { generation });
    }
  };

  /** Whether the sim is playing as the chrome believes it (D-07); absent, playing. */
  const isPlaying = (): boolean => deps.isPlaying?.() ?? true;
  /** FAIL-01 (D-12): whether the host's sim loop has ended (`GestureDeps.isSimStopped`). */
  const simStopped = (): boolean => deps.isSimStopped?.() === true;
  // The predicted seams' fallback reads the same play state, at read time, from the belts
  // layer (plan 88-06, D-07); cleared again at teardown.
  setPendingSeamsPlayState(isPlaying);

  /** Paint pending Place `p`'s waiting shimmer in the overlay's one slot. */
  const showShimmerOf = (p: PendingPlacement): void => {
    overlay.showPending(p.cell, p.dims);
    shimmerOwner = p.gestureId;
  };

  /** Clear the overlay's one shimmer slot, whoever it showed. */
  const clearShimmer = (): void => {
    overlay.clearPending();
    shimmerOwner = null;
  };

  /**
   * End pending Place `p` (phase 88, D-06, D-10): it leaves the list, and when the shimmer
   * slot shows it the slot is cleared and the newest still-live entry's shimmer is painted
   * in its place (research Pitfall 9). Another pending Place keeps its own mark.
   */
  const endPlacement = (p: PendingPlacement): void => {
    pendingPlacements = pendingPlacements.filter((q) => q !== p);
    if (shimmerOwner !== p.gestureId) {
      return;
    }
    clearShimmer();
    for (let i = pendingPlacements.length - 1; i >= 0; i--) {
      if (!pendingPlacements[i].abandoned) {
        showShimmerOf(pendingPlacements[i]);
        return;
      }
    }
  };

  /**
   * Accepted Place `p` lands (phase 88, D-06): its queued Rotates and its preset seeding go
   * out addressed to the accept's own (generation, handle), so the host resolves them in that
   * table (plan 88-04) and reaches the machine the Place minted, or refuses them.
   *
   * At the accept's generation (`atAccept`) `node` is that very machine in the scene, and a
   * refusal shows its sentence. At a later one (a keyframe overtook the accept) `node` is the
   * machine of this kind on this anchor in the newest scene, read only for its ports (both are
   * a fresh machine of one kind, and if it is not the minted one the host refuses the seeding
   * anyway); the address is still the accept's, and every frame goes out QUIET, so a refusal
   * shows no sentence about a turn the user made on a ghost (T-88-25 re-audit). The client
   * never addresses a machine it named again by kind and anchor: that could be another
   * machine dropped there after an Undo. A Label is selected and asks for focus only at the
   * accept's own generation, and an abandoned Label never does (D-08).
   */
  const landPlacement = (p: PendingPlacement, node: NodeView, atAccept: boolean): void => {
    endPlacement(p);
    if (p.abandoned || p.accepted === null) {
      return;
    }
    const { generation, handle } = p.accepted;
    const opts = atAccept ? { generation } : { generation, quiet: true };
    // CW only: the ghost's rot counter is canonicalized to 0..3 CW turns, so a CCW ghost
    // rotation never needs a ccw:true frame (CTRL-03, Finding 4).
    for (let i = 0; i < p.rotCount; i++) {
      sendInput(encodeGridCommand({ kind: 'Rotate', node: handle, ccw: false }), opts);
    }
    // ROUTE-06: a Router preset seeds its typed ports right after any queued Rotates, read off
    // the node as `scene` shows it and addressed to the accept's handle.
    if (p.presetMedium != null) {
      seedRouterPreset({ id: handle, ports: node.ports }, p.presetMedium, generation, !atAccept);
    }
    // Phase 76 (UI-SPEC U-4): LABEL PLACEMENT IS ONE-SHOT. A note always needs its words
    // before the next one, so when a label's Place lands the tool lets go (through the
    // shipped disarm path, so the palette row un-presses) and the new label becomes the
    // selection, which opens its side panel. This is the EIGHTH selection site, and like the
    // other seven it drives both channels. A Place the host refuses never lands, so the tool
    // stays armed for another try. Only the label TOOL is put down: a user who has already
    // armed something else since keeps it (and that arm abandoned this entry, above).
    if (atAccept && node.kind === machine_kind.LABEL) {
      if (placementKind === machine_kind.LABEL) {
        disarmPlacement();
      }
      selection = { kind: 'node', id: node.id };
      overlay.clearBeltHandles();
      clearHandleHover();
      overlay.showSelection(node.id);
      deps.onSelect?.(node.id);
      deps.onSelectBelt?.(null);
      // 76-02 (UI-SPEC 2.1): and ONLY on this path, ask for the Text field's focus.
      deps.onLabelPlaced?.(node.id);
    }
  };

  /**
   * Whether accepted Place `p` can land on `scene`, and land it if so: the packet holds the
   * minted handle at the accept's generation, or the scene has moved to a later generation
   * (a keyframe came first, research Pitfall 3). True when the entry ended, landed or not.
   */
  const tryLand = (p: PendingPlacement, scene: SceneState): boolean => {
    if (p.accepted === null) {
      return false;
    }
    const { generation, handle } = p.accepted;
    if (scene.generation === generation) {
      const node = scene.nodes.get(handle);
      if (node === undefined) {
        return false;
      }
      landPlacement(p, node, true);
      return true;
    }
    if (scene.generation > generation) {
      // A later table. The accept's (generation, handle) may no longer name a live node:
      // after an Undo then a Redo the restored machine has a new node id, and table
      // `generation` maps the handle to the dead one (phase 88 review, IN-02; T-88-25). Only
      // the host knows, so the follow-ups still go to the accept's own address, sent QUIET:
      // applied to the minted machine while it lives, refused in silence once it is gone.
      // The client never re-addresses them to the machine of this kind on this anchor in the
      // newest table (an earlier version did): after an Undo, that can be another machine the user
      // dropped there, which would take this Place's turns (T-88-25 re-audit). No machine of
      // this kind there means a later edit took it away, and the entry ends with nothing
      // sent. Nor across a swap (T-88-11): the accept was written on a replaced board.
      // `onSwap` ends every pending Place this page's own swap replaced, and the scene's swap
      // floor catches any other swap.
      const hits =
        generation < floorOf(scene)
          ? []
          : [...scene.nodes.values()].filter(
              (n) => n.kind === p.kind && n.cell_x === p.cell.cx && n.cell_y === p.cell.cy,
            );
      if (hits.length === 1) {
        landPlacement(p, hits[0], false);
      } else {
        endPlacement(p);
      }
      return true;
    }
    return false;
  };

  // Poll the echoed scene while any Place is pending (phase 88, D-06, D-07). An accepted
  // entry lands once a packet shows its handle; the waiting shimmer marks its cell until
  // then, the honest "awaiting host truth" affordance, never a false-success build-blue
  // persist (IX-05). A refusal ends its entry from `onVerdict`, not from here.
  const watchEcho = (): void => {
    echoRaf = 0;
    if (pendingPlacements.length === 0) {
      return;
    }
    const scene = getScene();
    const playing = isPlaying();
    for (const p of [...pendingPlacements]) {
      if (tryLand(p, scene)) {
        continue;
      }
      // THE ONE TIMER LEFT (D-07): a Place whose verdict was lost (a socket that
      // reconnected), or whose accept never met a packet holding its handle, ends here with
      // nothing sent once the sim has run `ECHO_TTL_TICKS` PLAYING ticks past its send or
      // its last Resume. Ticks a pause drained never count (`onResume` restarts the count),
      // so a Place queued on a paused board is never ended before it is answered. No
      // inference fallback (research Open Question 1): to the user this looks like a
      // refusal without a sentence.
      if (playing && scene.tick > p.emitTick + ECHO_TTL_TICKS) {
        endPlacement(p);
      }
    }
    if (pendingPlacements.length > 0) {
      echoRaf = requestAnimationFrame(watchEcho);
    }
  };

  /** Keep exactly ONE `watchEcho` RAF loop running while any Place is pending. */
  const ensureEchoWatch = (): void => {
    if (pendingPlacements.length > 0 && !echoRaf) {
      echoRaf = requestAnimationFrame(watchEcho);
    }
  };

  /**
   * The host's answer to one gesture (phase 88, D-06; see {@link GestureController.onVerdict}).
   * A pending Place, a held belt (its DrawBelt) or a sent Dock is found by the gesture id its
   * send returned; any other id does nothing.
   */
  const onVerdict = (v: GestureVerdict): void => {
    const p = pendingPlacements.find((q) => q.gestureId === v.seq);
    if (p === undefined) {
      const f = beltFollowUps.find((q) => q.gestureId === v.seq);
      if (f !== undefined) {
        onBeltVerdict(f, v);
        return;
      }
      // A Dock a landed follow-up sent: refused or discarded, its belt's predicted seam ends
      // now (the end is not joined); accepted, the seam resolves when the packet shows it.
      const sent = v.seq === undefined ? undefined : dockOwners.get(v.seq);
      if (sent !== undefined && v.seq !== undefined) {
        dockOwners.delete(v.seq);
        if (v.kind !== 'gestureAccepted') {
          endPendingSeams(sent.owner);
        }
      }
      // Otherwise: another kind of gesture, a header the host could not read (no `seq`), or
      // an entry already ended, whose later verdict is ignored.
      return;
    }
    if (v.kind !== 'gestureAccepted') {
      // Refused, or discarded by a board swap: it never minted, so nothing is sent and its
      // waiting shimmer clears now, leaving the red flash the only mark (D-10, FAIL-07).
      endPlacement(p);
      return;
    }
    if (p.accepted !== null) {
      // The same accept delivered twice: the first one already counts.
      return;
    }
    const handle = v.minted[0];
    if (handle === undefined) {
      // An accept that names no handle (the host could not pair its mints, and said so on
      // its side) gives the client nothing to address: end with nothing sent.
      endPlacement(p);
      return;
    }
    p.accepted = { generation: v.generation, handle };
    // The packet may already be here (packet before accept): land now, else the watch does.
    if (!tryLand(p, getScene())) {
      ensureEchoWatch();
    }
  };

  /**
   * A swap's keyframe is in the scene (T-88-11; see {@link GestureController.onSwap}): every
   * held belt and every sent Dock ends with nothing more sent, and the swap's generation
   * becomes the floor below which no accept is named again.
   */
  const onSwap = (): void => {
    swapGeneration = Math.max(swapGeneration, getScene().generation);
    endEveryBeltFollowUp();
    // A path drawn on the replaced board is not a path on this one (plan 89-07): a swap's keyframe
    // (New, Open, an example, a Load) ends it, nothing sent, before `clearSelection` would keep it
    // as it keeps a path across an Undo's keyframe (D-11). The tool stays armed.
    if (drawnCells !== null) {
      dropBeltPath();
    }
    // Every pending Place too (T-88-25): its Rotates and preset seeding were owed on the
    // replaced board. One still unanswered is discarded by the host and its verdict, when it
    // comes, finds no entry.
    for (const p of [...pendingPlacements]) {
      endPlacement(p);
    }
  };

  /** The sim resumed at `tick` (D-07): every timed count restarts there. */
  const onResume = (tick: number): void => {
    for (const p of pendingPlacements) {
      p.emitTick = tick;
    }
    for (const r of pendingRots.values()) {
      r.emitTick = tick;
    }
    // Plan 88-06: the held belts' lost-verdict fallback and every predicted seam's own.
    for (const f of beltFollowUps) {
      f.emitTick = tick;
    }
    for (const d of dockOwners.values()) {
      d.emitTick = tick;
    }
    resumePendingSeams(tick);
  };

  /**
   * Arming a tool gives up every pending placement's follow-ups (WR-A, WR-B, D-08): the
   * queued Rotates, preset seeding and label focus request die and the shimmer clears.
   *
   * No entry is dropped (phase 88, D-06): each still ends on its own verdict, with nothing
   * left to send. Until phase 88 an entry whose cell looked covered at the drop was dropped
   * here and one whose cell looked free kept watching to claim its node, both guesses at
   * which Place the host would mint.
   */
  const abandonPendingPlacements = (): void => {
    if (pendingPlacements.length === 0) {
      return;
    }
    for (const p of pendingPlacements) {
      p.abandoned = true;
      p.rotCount = 0;
      p.presetMedium = null;
    }
    clearShimmer();
    ensureEchoWatch();
  };

  // ---- belt-echo follow-up (RESEARCH Pattern 1, generalized watchEcho) ------
  // After a DrawBelt emit, follow-up Docks must WAIT for the host to mint the belt: a
  // same-tick batch can NEVER reference a same-batch mint (the hard drain constraint,
  // Finding 4: `node_for_handle` resolves only handles minted by PRIOR folds).
  //
  // ONE ENTRY PER COMMITTED DrawBelt, KEYED BY ITS GESTURE ID (phase 88, D-06). Plan 74.1-30
  // gave every committed DrawBelt its own entry (PAUSE-SECOND-DRAW: a single slot let a
  // second paused draw wipe the first belt's Docks); it was keyed by its exact cells and found
  // its belt by exact tile equality against the echo. Since phase 88 the host answers every
  // gesture, so the entry is the id `sendInput` returned for its DrawBelt and it ends on that
  // gesture's own verdict:
  //
  //   - REFUSED OR DISCARDED (a board swap): it never minted, so nothing is sent, and its held
  //     picture and its predicted seam go in the same frame.
  //   - ACCEPTED: the accept names the minted belt's handle and the generation of the table it
  //     was written in. Once a packet of that generation holds the belt, or a keyframe of a
  //     higher generation comes first (research Pitfall 3), every owed Dock goes out addressed
  //     to that handle with that generation, so the host reads it in the table the accept was
  //     written from (plan 88-04) or refuses it with a sentence. A keyframe never drops an
  //     owed Dock (plan 88-06): until then every keyframe ended every held belt.
  //   - ACCEPTED IN A LATER TABLE THAN IT WAS DRAWN ON: a Ctrl+Z queued on a paused board
  //     folds before the draw behind it, so the belt is minted in the Undo's new table while
  //     the Docks' machines were read off the pre-Undo board. One Dock frame carries one
  //     generation, so each machine (or belt end) the user docked to is named again in the
  //     accept's table, from the packet that holds the minted belt: the one machine of the same
  //     kind on the same cell with the same port in the same place (or the one belt with the
  //     same cells). A dock with no such single match is not sent, and the belt's predicted
  //     seam ends.
  //   - NO VERDICT (a lost one): the fallback ends it with nothing sent once the board has run
  //     `ECHO_TTL_TICKS` PLAYING ticks past its release or its last Resume (D-07). Until phase
  //     88 every tick counted, and a draw released early in a pause's drain (up to 512 ticks
  //     with input held) expired while still paused: on Play the belt landed with no Dock and
  //     no message (BELT-05).
  //
  // Two draws on the same cells are two entries: the host keeps the first and refuses the
  // second, whose refusal ends only its own entry.
  /**
   * What a dock's target looked like on the board the draw was made on (plan 88-06): enough
   * to name the same machine or belt again in a later table, never a handle. Null when the
   * handle named nothing on that board.
   */
  type DockTarget =
    | { kind: 'machine'; machineKind: number; cell: [number, number]; port: { x: number; y: number; side: number } }
    | { kind: 'belt'; cells: [number, number][] }
    | null;
  interface BeltFollowUp {
    /** The gesture id `sendInput` returned for the DrawBelt (the verdict's `seq`); the key. */
    gestureId: number;
    /** route()-normalized tile cells snapshotted at DrawBelt emit. */
    tiles: [number, number][];
    docks: Array<{ end: BeltEnd; node: number; portIndex: number; target: DockTarget }>;
    /** The board generation the draw was made on: every dock's `node` is a handle of its table. */
    drawGeneration: number;
    /**
     * scene.tick at DrawBelt emit, or at the last Resume since (`onResume`): the lost-verdict
     * fallback's baseline, counted only while playing (D-07).
     */
    emitTick: number;
    /**
     * THE HELD PICTURE of this belt (plan 74.1-30, walk item S1R): `seamEndTiles` of the
     * routed tiles with the feed captured at the release and the release's head drain,
     * the SAME value the pending-seam record holds. Shown on the overlay's held-picture
     * surface from the release until this entry ends. Built once, at the release, so
     * nothing can repaint it after the gesture's feed is cleared.
     */
    picture: TileView[];
    /** The accept's minted belt and its generation, once heard (D-06); null before. */
    accepted: { generation: number; handle: number } | null;
  }
  let beltFollowUps: BeltFollowUp[] = [];
  let followUpRaf = 0;
  /**
   * The Docks a landed follow-up sent, by their own gesture id, each mapped to its DrawBelt's
   * id (its pending-seam record's owner). A Dock refused or discarded ends that record at once
   * (D-06): the belt is not joined at that end, so the corner the record predicts is not true.
   *
   * A Dock whose verdict never comes (a dev WebSocket reconnect) is forgotten on the same
   * playing-tick fallback as every other record of a gesture (phase 88 review, IN-05):
   * `emitTick` is the send tick or the last Resume, and only playing ticks count. The belt
   * watcher keeps running while any Dock waits, so the fallback is read.
   */
  const dockOwners = new Map<number, { owner: number; emitTick: number }>();

  /** Forget every sent Dock past the playing-tick fallback (IN-05). */
  const pruneDockOwners = (scene: SceneState, playing: boolean): void => {
    if (!playing) {
      return;
    }
    for (const [id, d] of [...dockOwners]) {
      if (scene.tick > d.emitTick + ECHO_TTL_TICKS) {
        dockOwners.delete(id);
      }
    }
  };

  // Repaint the held-picture surface from the entries still waiting. The surface is the
  // overlay's own (74.1-30), so this never touches the drag preview a new gesture draws.
  const paintHeldBelts = (): void => {
    if (beltFollowUps.length === 0) {
      overlay.clearHeldBelts();
    } else {
      overlay.showHeldBelts(beltFollowUps.map((f) => f.picture));
    }
  };

  /**
   * Take follow-up `f` off the list. `sent` false (a refusal, a discard, an accept naming no
   * belt, the fallback): its predicted seam ends with it, because no Dock is coming. `sent`
   * true: its Docks went out, and the record stays until they echo (or are refused). The
   * caller repaints the held surface once.
   */
  const dropBeltFollowUp = (f: BeltFollowUp, sent: boolean): void => {
    beltFollowUps = beltFollowUps.filter((q) => q !== f);
    if (!sent) {
      endPendingSeams(f.gestureId);
    }
  };

  // End EVERY entry: its Docks are never sent, its held picture and its predicted seam
  // clear. Only at teardown (destroy()) and at a swap's keyframe (`onSwap`, T-88-11: the
  // board the Docks were owed on is gone), never for a new gesture (74.1-30) and, since plan
  // 88-06, never for any other keyframe. Until then clearSelection, the WR-01 full:true
  // keyframe hook, came through here because a reminted handle could name a DIFFERENT
  // element (T-21-13); each Dock now goes out addressed to the generation its handles were
  // read in, and the host resolves it in that table or refuses it with a sentence, so the
  // keyframe has nothing left to protect and dropping the Docks was the defect. A new
  // press, Escape, right-click, arming another tool and a new DrawBelt do not come through
  // here either: each entry is a committed belt whose Docks are still owed (PAUSE-SECOND-
  // DRAW). Renamed from `abandonBeltFollowUp`, whose single slot every gesture dropped.
  const endEveryBeltFollowUp = (): void => {
    beltFollowUps = [];
    dockOwners.clear();
    overlay.clearHeldBelts();
    // Every predicted seam dies with its entry here (74.1-20): none of these callers may
    // leave a corner drawn for a dock no one is sending any more. An entry's NORMAL end
    // (its accept and its packet in, its Docks out) does not come through here, so its
    // prediction survives until the Dock echoes.
    clearPendingSeams();
    if (followUpRaf) {
      cancelAnimationFrame(followUpRaf);
      followUpRaf = 0;
    }
  };

  /**
   * Accepted follow-up `f` lands (D-06): every owed Dock goes out addressed to the minted
   * belt `belt`, with the accept's `generation`. UNCONDITIONALLY, since Phase 64 (D-07, D-08):
   * a dock that no longer fits (a machine rotated while the belt was in flight) is refused by
   * the host in words rather than dropped in silence. The Docks may ride one drain batch
   * together: the belt handle exists now.
   *
   * THE DRAWN BELT REPLACES THIS PICTURE IN THIS FRAME (74.1-26, S1R). The minted belt is in
   * the scene the belts layer draws this frame, with the predicted seam the release recorded
   * (74.1-20), so the caller repaints the held surface without this entry in the same frame,
   * and no frame shows neither. A draw that docks nothing has an empty list and only this.
   */
  const landBeltFollowUp = (f: BeltFollowUp, belt: number, generation: number, scene: SceneState): void => {
    dropBeltFollowUp(f, true);
    let unnamed = false;
    for (const d of f.docks) {
      // Drawn on the board of `generation`: the recorded handle is a handle of that table.
      // Drawn on an earlier board: named again in `generation`'s table, the scene's (see the
      // note above and `tryLandBelt`).
      const node = generation === f.drawGeneration ? d.node : nameAgain(d.target, d.portIndex, scene);
      if (node === null) {
        unnamed = true;
        continue;
      }
      // Its claim (plan 88-07, D-09): the source the link will take, until the Dock is answered.
      const id = sendInput(encodeGridCommand({ kind: 'Dock', belt, end: d.end, node, port: d.portIndex }), {
        generation,
        // The target's role is the one recorded at the release (WR-01): `node` may be a handle
        // of an older table than `scene`, where the same number can name a belt or a machine.
        claim: dockClaim({ belt, end: d.end, node, port: d.portIndex, targetIsBelt: d.target?.kind === 'belt' }),
      });
      // An id of 0 is nothing sent (no transport): no verdict will name it (IN-05).
      if (id !== 0) {
        dockOwners.set(id, { owner: f.gestureId, emitTick: scene.tick });
      }
    }
    if (unnamed) {
      endPendingSeams(f.gestureId);
      // A Dock this belt was owed is not sent (plan 89-09, D-14, WINDOWS 254): its target could
      // not be named again in the accept's table. No command exists for the host to refuse, so
      // the client says so; until this plan the drop ended only the predicted seam.
      deps.onClientRefusal?.('DockNotSent');
    }
  };

  /**
   * The handle, in `scene`'s table, of the one machine or belt that matches `target` exactly,
   * or null when none or more than one does (plan 88-06). A machine matches on its kind, its
   * cell and port `portIndex` at the same cell facing the same side; a belt on its cells.
   */
  const nameAgain = (target: DockTarget, portIndex: number, scene: SceneState): number | null => {
    if (target === null) {
      return null;
    }
    const hits: number[] = [];
    if (target.kind === 'machine') {
      for (const n of scene.nodes.values()) {
        const p = n.ports.find((q) => q.index === portIndex);
        if (
          n.kind === target.machineKind &&
          n.cell_x === target.cell[0] &&
          n.cell_y === target.cell[1] &&
          p !== undefined &&
          p.cell_x === target.port.x &&
          p.cell_y === target.port.y &&
          p.side === target.port.side
        ) {
          hits.push(n.id);
        }
      }
    } else {
      for (const b of scene.belts.values()) {
        if (
          b.tiles.length === target.cells.length &&
          b.tiles.every((t, i) => t.cell_x === target.cells[i][0] && t.cell_y === target.cells[i][1])
        ) {
          hits.push(b.id);
        }
      }
    }
    return hits.length === 1 ? hits[0] : null;
  };

  /** What dock target handle `node` names on `scene`, the board a draw is made on (plan 88-06). */
  const dockTargetOf = (node: number, portIndex: number, scene: SceneState): DockTarget => {
    const n = scene.nodes.get(node);
    if (n !== undefined) {
      const p = n.ports.find((q) => q.index === portIndex);
      if (p === undefined) {
        return null;
      }
      return {
        kind: 'machine',
        machineKind: n.kind,
        cell: [n.cell_x, n.cell_y],
        port: { x: p.cell_x, y: p.cell_y, side: p.side },
      };
    }
    const b = scene.belts.get(node);
    return b === undefined ? null : { kind: 'belt', cells: b.tiles.map((t) => [t.cell_x, t.cell_y]) };
  };

  /**
   * Whether accepted follow-up `f` can land on `scene`, and land it if so: the packet holds the
   * minted belt at the accept's generation, or the scene has moved to a later generation (a
   * keyframe came first, research Pitfall 3; the Docks still go out addressed, plan 88-04's
   * host resolves or refuses them). True when it landed; the caller repaints.
   */
  const tryLandBelt = (f: BeltFollowUp, scene: SceneState): boolean => {
    if (f.accepted === null) {
      return false;
    }
    const { generation, handle } = f.accepted;
    if (scene.generation < generation) {
      return false;
    }
    if (scene.generation === generation) {
      if (!scene.belts.has(handle)) {
        return false;
      }
      landBeltFollowUp(f, handle, generation, scene);
      return true;
    }
    // A swap came between the accept and this scene (T-88-11): the belt was minted on the
    // replaced board. `onSwap` ends every held belt at once when this page asked for the
    // swap; the scene's swap floor catches every other one (a Load from another client, or a
    // swap whose claim an earlier keyframe used up; T-88-11 re-audit). Nothing is owed on the
    // loaded board, and nothing is named again in it.
    if (generation < floorOf(scene)) {
      // Silent (plan 89-09, D-14, Pitfall 10): nothing is owed on a loaded board.
      dropBeltFollowUp(f, false);
      return true;
    }
    // A keyframe of a later generation came first. Drawn on the accept's own board, the
    // Docks go out addressed to it all the same. Drawn on an earlier one, the machines could
    // only be named again from a packet of the accept's own table, which will not come now,
    // so the belt and each target are named again in the NEWEST table, the scene in hand, by
    // the same exact match, and the Docks go out addressed to it (phase 88 review, IN-01:
    // until then nothing was sent and the belt landed undocked with no word). No belt on
    // exactly the drawn cells there means a later edit took the belt away: nothing is owed.
    if (generation === f.drawGeneration) {
      landBeltFollowUp(f, handle, generation, scene);
    } else {
      const belt = nameAgain({ kind: 'belt', cells: f.tiles }, 0, scene);
      if (belt === null) {
        // Silent (plan 89-09, D-14, Pitfall 10): the belt is gone, so no Dock is owed to it.
        dropBeltFollowUp(f, false);
      } else {
        landBeltFollowUp(f, belt, scene.generation, scene);
      }
    }
    return true;
  };

  // Poll the echoed scene each frame while any follow-up waits. Emission happens ONLY from
  // here, once the accept AND the packet are in, never from the event handler that emitted
  // the mint (Pitfall 2: a same-batch Dock is a silent UnknownNode reject) nor from the
  // verdict handler (see `onBeltVerdict`).
  const watchBeltFollowUp = (): void => {
    followUpRaf = 0;
    if (beltFollowUps.length === 0 && dockOwners.size === 0) {
      return;
    }
    const scene = getScene();
    const playing = isPlaying();
    pruneDockOwners(scene, playing);
    let ended = false;
    for (const f of [...beltFollowUps]) {
      if (tryLandBelt(f, scene)) {
        ended = true;
        continue;
      }
      // THE LOST-VERDICT FALLBACK (D-07): only PLAYING ticks count, and `onResume` restarts
      // the count, so a pause's drain never ends a held belt. Only THIS entry ends, with
      // nothing sent; its held picture and its predicted seam go with it.
      if (playing && scene.tick > f.emitTick + ECHO_TTL_TICKS) {
        dropBeltFollowUp(f, false);
        ended = true;
        // Docks were owed and none will be sent (plan 89-09, D-14): say so. An entry that owed
        // none (an undocked draw) ends in silence, as there is nothing missing.
        if (f.docks.length > 0) {
          deps.onClientRefusal?.('DockNotSent');
        }
      }
    }
    if (ended) {
      paintHeldBelts();
    }
    if (beltFollowUps.length > 0 || dockOwners.size > 0) {
      followUpRaf = requestAnimationFrame(watchBeltFollowUp);
    }
  };

  /** Keep exactly ONE `watchBeltFollowUp` RAF loop running while any follow-up or Dock waits. */
  const ensureBeltWatch = (): void => {
    if ((beltFollowUps.length > 0 || dockOwners.size > 0) && !followUpRaf) {
      followUpRaf = requestAnimationFrame(watchBeltFollowUp);
    }
  };

  /**
   * The host's answer to the DrawBelt of follow-up `f` (D-06). A refusal or a discard ends it
   * with nothing sent and its picture and seam gone in this frame. An accept records the
   * minted belt (an accept naming none ends it with nothing sent: there is nothing to
   * address), and the watcher lands it on the next frame whose scene holds the belt.
   *
   * THE LAND WAITS FOR A FRAME even when the packet is already here (the host writes the
   * tick's packet before its accepts), as the echo watcher always did: the Docks go out from
   * a frame that draws the minted belt, so the held picture hands over to the drawn belt in
   * that frame (74.1-26), and the frames between the belt and its Dock's echo, which the
   * predicted seam draws, still exist on a slow page (`74.1-release-and-undo` leg 5 grades
   * them). Landing here, between frames, sent the Docks up to a frame sooner and let a page
   * at the CPU quota draw no frame of the belt before its Dock folded.
   */
  const onBeltVerdict = (f: BeltFollowUp, v: GestureVerdict): void => {
    if (v.kind !== 'gestureAccepted') {
      dropBeltFollowUp(f, false);
      paintHeldBelts();
      return;
    }
    if (f.accepted !== null) {
      return;
    }
    const handle = v.minted[0];
    if (handle === undefined) {
      dropBeltFollowUp(f, false);
      paintHeldBelts();
      // An accept that names no belt gives the owed Docks nothing to address (plan 89-09, D-14).
      if (f.docks.length > 0) {
        deps.onClientRefusal?.('DockNotSent');
      }
      return;
    }
    f.accepted = { generation: v.generation, handle };
    ensureBeltWatch();
  };

  // Add the entry for a just-emitted DrawBelt, keyed by its gesture id, and show its held
  // picture. Emission happens ONLY once its accept and a packet holding the belt are in,
  // NEVER synchronously here (the belt handle does not exist yet; Pitfall 2's silent
  // UnknownNode).
  const armBeltFollowUp = (
    gestureId: number,
    tiles: [number, number][],
    docks: Array<{ end: BeltEnd; node: number; portIndex: number }>,
    picture: TileView[],
  ): void => {
    const scene = getScene();
    beltFollowUps.push({
      gestureId,
      tiles,
      docks: docks.map((d) => ({ ...d, target: dockTargetOf(d.node, d.portIndex, scene) })),
      drawGeneration: scene.generation,
      emitTick: scene.tick,
      picture,
      accepted: null,
    });
    paintHeldBelts();
    ensureBeltWatch();
  };

  // Arm DrawBelt-only draw mode (the palette Belt tool). Belts are DRAWN + DOCKED,
  // never Placed — this is its own entry point, NOT a `Place(BELT)` sentinel routed
  // through `beginPlacement` (the core rejects Place{BELT}, 17-02). Pan stays
  // suspended until a belt is drawn or the tool is cancelled (Esc / right-click).
  const armBeltDraw = (): void => {
    // FAIL-01 (D-12): nothing is armed on a stopped simulation.
    if (simStopped()) return;
    // Re-clicking the armed Belt tool disarms it (Factorio re-click toggle, IX-03).
    if (beltArmed) {
      disarmBelt();
      return;
    }
    // A TOOL ARMED MID-GESTURE (plan 89-07, the 89-06 carry-over): a no-tool press or drag still
    // in flight (an output-dot drag, a handle drag) ends with nothing sent, so it cannot steer or
    // dock under the new tool.
    cancelIdleGesture();
    if (echoRaf) {
      cancelAnimationFrame(echoRaf);
      echoRaf = 0;
    }
    // A committed belt's follow-up entry SURVIVES arming a tool (plan 74.1-30): its Docks
    // are still owed and its held picture ends on its own echo (PAUSE-SECOND-DRAW).
    // WR-B (IX-05 honesty): a superseding tool switch cancels the echo watch's
    // follow-ups, but it must ALSO clear the neutral pending shimmer — the watcher was its
    // only cleaner, so without this the shimmer strands, pulsing forever over
    // the committed machine. WR-A: abandon EVERY pending placement (each with
    // its own queued Rotates). clearPending is idempotent.
    // The follow-ups die, the entries do not: each still ends on its own verdict, with
    // nothing left to send (phase 88, D-06; see `abandonPendingPlacements`).
    abandonPendingPlacements();
    placementKind = null;
    placementPresetMedium = null;
    ghost.clear();
    // IX-03 mutual exclusion, site 1 of 3. Exactly one tool is armed, and the
    // rule is enforced HERE rather than in React: the palette derives its
    // `.is-armed` state from `onArmedChange`, so two tools lighting at once is a
    // gesture-layer bug, not a chrome one. The other two sites are
    // `beginPlacement`/`beginRouterPreset` and `armWireDraw`.
    wireArmed = false;
    wireSource = null;
    overlay.clearRoute();
    // The rings die with the tool. A superseding tool that dropped `wireArmed` but
    // left the affordance painted would leave the board claiming a wire can start
    // somewhere while the Wire tool is put away (IX-03 is enforced HERE, not React).
    overlay.clearWireTargets();
    beltArmed = true;
    drawnCells = null;
    drawnFrom = null;
    startDock = null;
    startFeed = null;
    startIn = null;
    beltPointer = null;
    overlay.clearBeltPreview();
    // THE RESTING AFFORDANCE, PAINTED AT THE ARM (LINK-02/LINK-10, 74-UI-SPEC 1.2),
    // exactly as `armWireDraw` paints the wire rings at its own arm. This is the moment
    // the board tells the user which belt ends a new run can be joined onto, BEFORE any
    // press - which is the half of WINDOWS 140 that no model fix could supply.
    paintDockTargets();
    cam.setPanEnabled(false);
    // IX-03: a distinct crosshair build cursor while armed (set positively,
    // honouring the Phase-29 camera cursor-ownership seam — the camera is silent
    // while panEnabled is false). Report the armed tool to the chrome.
    canvas.style.cursor = 'crosshair';
    deps.onArmedChange?.({ kind: 'belt' });
  };

  // Arm the wire draw (the palette Wire tool, WIRE-02). Mirrors `armBeltDraw`
  // above in shape, hop for hop, because the two are the same KIND of tool: a
  // drawn connection rather than a placed machine.
  const armWireDraw = (): void => {
    // FAIL-01 (D-12): nothing is armed on a stopped simulation.
    if (simStopped()) return;
    // Re-clicking the armed Wire tool disarms it (Factorio re-click toggle, IX-03).
    if (wireArmed) {
      disarmWire();
      return;
    }
    // A TOOL ARMED MID-GESTURE (plan 89-07, the 89-06 carry-over): a no-tool press or drag still
    // in flight (an output-dot drag, a handle drag) ends with nothing sent, so it cannot steer or
    // dock under the new tool.
    cancelIdleGesture();
    if (echoRaf) {
      cancelAnimationFrame(echoRaf);
      echoRaf = 0;
    }
    // A committed belt's follow-up entry SURVIVES arming a tool (plan 74.1-30): its Docks
    // are still owed and its held picture ends on its own echo (PAUSE-SECOND-DRAW).
    // WR-B (IX-05 honesty): a superseding tool switch cancels the echo watch's
    // follow-ups and must ALSO clear the neutral pending shimmer, whose only cleaner was the
    // watcher. WR-A: abandon EVERY pending placement. clearPending is idempotent.
    // The follow-ups die, the entries do not: each still ends on its own verdict, with
    // nothing left to send (phase 88, D-06; see `abandonPendingPlacements`).
    abandonPendingPlacements();
    placementKind = null;
    placementPresetMedium = null;
    ghost.clear();
    // IX-03 mutual exclusion, site 3 of 3 (see armBeltDraw).
    beltArmed = false;
    drawnCells = null;
    drawnFrom = null;
    startDock = null;
    startFeed = null;
    startIn = null;
    beltPointer = null;
    overlay.clearBeltPreview();
    // The BELT tool's rings die with the belt tool for the same reason the wire ones
    // die with the wire tool three lines below: a superseding tool that dropped
    // `beltArmed` but left the affordance painted would leave the board offering a join
    // with the Belt tool put away.
    overlay.clearDockTargets();
    wireArmed = true;
    wireSource = null;
    // THE RESTING AFFORDANCE, PAINTED AT THE ARM (WIRE-05). This is the moment the
    // board tells the user where a wire can start, and it is the whole answer to
    // WINDOWS row 113: three hand-placed Router Outs light at once, before a press.
    paintWireTargets();
    cam.setPanEnabled(false);
    // IX-03: the same crosshair build cursor the Belt tool sets, positively, and
    // honouring the Phase-29 camera cursor-ownership seam. Report the armed tool.
    canvas.style.cursor = 'crosshair';
    deps.onArmedChange?.({ kind: 'wire' });
  };

  const beginPlacement = (kind: number): void => {
    // FAIL-01 (D-12): nothing is armed on a stopped simulation.
    if (simStopped()) return;
    // Re-clicking the already-armed machine disarms it (Factorio re-click
    // toggle, IX-03) — arming the SAME kind twice is "put the tool back". A
    // Router PRESET is a distinct arm (placementPresetMedium set), so the plain
    // Router entry re-arms cleanly over an armed preset rather than toggling off.
    if (placementKind === kind && placementPresetMedium == null) {
      disarmPlacement();
      return;
    }
    // A TOOL ARMED MID-GESTURE (plan 89-07, the 89-06 carry-over): a no-tool press or drag still
    // in flight (an output-dot drag, a handle drag) ends with nothing sent, so it cannot steer or
    // dock under the new tool.
    cancelIdleGesture();
    // A new placement supersedes any pending placement echo watch
    // (superseding-gesture discipline). Not a belt's follow-up entry (74.1-30).
    if (echoRaf) {
      cancelAnimationFrame(echoRaf);
      echoRaf = 0;
    }
    // A committed belt's follow-up entry SURVIVES arming a tool (plan 74.1-30): its Docks
    // are still owed and its held picture ends on its own echo (PAUSE-SECOND-DRAW).
    // WR-B (IX-05 honesty): clear the neutral pending shimmer when a new
    // placement supersedes a still-pending one — otherwise the shimmer strands
    // over the prior committed machine (the watcher was its only cleaner).
    // WR-A: abandon EVERY pending placement (each with its own queued Rotates).
    // Idempotent; mirrors the clearSelection discipline.
    // The follow-ups die, the entries do not: each still ends on its own verdict, with
    // nothing left to send (phase 88, D-06; see `abandonPendingPlacements`).
    abandonPendingPlacements();
    beltArmed = false;
    // The Belt tool's path in progress goes with the tool (plan 89-07): its preview and armed
    // ring would otherwise stay painted under the machine ghost, and its cells feed nothing.
    if (drawnCells !== null) {
      dropBeltPath();
    }
    // IX-03 mutual exclusion, site 2 of 3 (see armBeltDraw).
    wireArmed = false;
    wireSource = null;
    overlay.clearRoute();
    // The rings die with the tool. A superseding tool that dropped `wireArmed` but
    // left the affordance painted would leave the board claiming a wire can start
    // somewhere while the Wire tool is put away (IX-03 is enforced HERE, not React).
    overlay.clearWireTargets();
    // The belt tool's rings die with it too (see armWireDraw).
    overlay.clearDockTargets();
    placementKind = kind;
    // A plain machine placement clears any prior preset arm (this is not a preset).
    placementPresetMedium = null;
    placementRot = 0;
    lastMovePoint = null;
    // Size the ghost to the machine's footprint so multi-cell drops (e.g. a 2x3
    // ROUTER) validate EVERY target cell and draw the real silhouette (14-04).
    ghost.setPlacement(kind, 0);
    cam.setPanEnabled(false);
    // IX-03: crosshair build cursor while armed (set positively; the camera is
    // silent while panEnabled is false — the Phase-29 cursor-ownership seam).
    canvas.style.cursor = 'crosshair';
    deps.onArmedChange?.({ kind: 'machine', machineKind: kind });
  };

  // Arm a ROUTE-06 Router preset (see GestureController.beginRouterPreset). Mirrors
  // beginPlacement over machine_kind.ROUTER but tags the placement with the preset
  // `medium` so the echo watcher seeds the typed ports. Re-clicking the SAME preset
  // toggles it off; switching presets (or to the plain Router) re-arms cleanly.
  const beginRouterPreset = (medium: number): void => {
    // FAIL-01 (D-12): nothing is armed on a stopped simulation.
    if (simStopped()) return;
    if (
      placementKind === machine_kind.ROUTER &&
      placementPresetMedium === medium
    ) {
      disarmPlacement();
      return;
    }
    // A TOOL ARMED MID-GESTURE (plan 89-07, the 89-06 carry-over): a no-tool press or drag still
    // in flight (an output-dot drag, a handle drag) ends with nothing sent, so it cannot steer or
    // dock under the new tool.
    cancelIdleGesture();
    if (echoRaf) {
      cancelAnimationFrame(echoRaf);
      echoRaf = 0;
    }
    // A committed belt's follow-up entry SURVIVES arming a tool (plan 74.1-30): its Docks
    // are still owed and its held picture ends on its own echo (PAUSE-SECOND-DRAW).
    // The follow-ups die, the entries do not: each still ends on its own verdict, with
    // nothing left to send (phase 88, D-06; see `abandonPendingPlacements`).
    abandonPendingPlacements();
    beltArmed = false;
    // The Belt tool's path in progress goes with the tool (see beginPlacement).
    if (drawnCells !== null) {
      dropBeltPath();
    }
    // IX-03 mutual exclusion, site 2 of 3 (see armBeltDraw), the preset arm.
    wireArmed = false;
    wireSource = null;
    overlay.clearRoute();
    // The rings die with the tool. A superseding tool that dropped `wireArmed` but
    // left the affordance painted would leave the board claiming a wire can start
    // somewhere while the Wire tool is put away (IX-03 is enforced HERE, not React).
    overlay.clearWireTargets();
    // The belt tool's rings die with it too (see armWireDraw).
    overlay.clearDockTargets();
    placementKind = machine_kind.ROUTER;
    placementPresetMedium = medium;
    placementRot = 0;
    lastMovePoint = null;
    ghost.setPlacement(machine_kind.ROUTER, 0);
    cam.setPanEnabled(false);
    canvas.style.cursor = 'crosshair';
    // IX-03: report the armed preset (machineKind + presetMedium) so the palette
    // highlights the SPECIFIC preset entry, not every Router-kind entry.
    deps.onArmedChange?.({
      kind: 'machine',
      machineKind: machine_kind.ROUTER,
      presetMedium: medium,
    });
  };

  // Disarm an armed placement (mirror disarmBelt): the tool leaves the hand.
  // Called by Esc, a right-click on the canvas, and the re-click toggle. Does
  // NOT touch pendingPlacements — a placement already committed keeps awaiting
  // its honest echo even after the tool is put down.
  const disarmPlacement = (): void => {
    placementKind = null;
    placementPresetMedium = null;
    placementRot = 0;
    lastMovePoint = null;
    ghost.clear();
    cam.setPanEnabled(true);
    canvas.style.cursor = '';
    deps.onArmedChange?.(null);
  };

  const finishPlacement = (e: PointerEvent): void => {
    const kind = placementKind;
    const presetMedium = placementPresetMedium;
    const rot = placementRot;
    // IX-06: the tool STAYS ARMED after a place (Factorio repeat placement) —
    // do NOT null placementKind/placementRot and do NOT restore pan here. The
    // only ways out of the armed state are Esc / right-click / re-click, all of
    // which route through disarmPlacement.
    if (kind === null) {
      return;
    }
    // A right/middle release is NOT the commit — right-click is a decisive
    // cancel handled on pointerdown (onCanvasDown), so here it simply emits
    // nothing and stays armed (WR-08).
    if (e.button !== 0) {
      return;
    }
    // Only a release that lands ON the canvas floor places. A release off the
    // floor (over the palette/chrome, where the follow-ghost is already hidden)
    // emits nothing and stays armed — never a stray node behind the panel.
    if (e.target !== canvas) {
      return;
    }
    const p = toLocal(e);
    const { cell, valid } = ghost.moveTo(p.x, p.y);
    if (!valid) {
      // IX-05 + D-07 (phase 64, SUPPRESSION SITE 1 of 6, and the only one this
      // plan removes): the ghost's verdict is ADVISORY, not a gate. It still
      // fires the one-shot reject flash over the attempted footprint, because
      // that flash is the optimistic half of the feedback rule and says WHERE -
      // and the tool STAYS ARMED. What it no longer does is RETURN.
      //
      // The early return that used to sit here is the shipped bug this phase
      // closes. The ghost predicts the host's answer, so when the prediction
      // says no, the click emitted nothing, the host was never asked, and the
      // user was told nothing at all - a dead click over an occupied cell. What
      // the player sees is now what the host is ASKED, and the host's answer is
      // what happens: a refusal comes back as a typed tag and becomes a sentence
      // on screen (ERR-01), and a prediction that was wrong resolves as a normal
      // accept instead of being silently swallowed by the client.
      overlay.showRejectFlash(cell, ghostDims(kind, rot));
    }
    // Authoritative: emit ONE logged Place. The machine appears ONLY when the
    // host echoes it (SC5, no optimistic scene write). Place is emitted UNCHANGED
    // (no rot field — schema untouched, always rot 0); a rotated ghost records
    // its rotCount on the pending placement instead, and the Rotates go out
    // ONLY once the host has accepted THIS Place and a packet shows the handle
    // the accept names (Finding 4, phase 88 D-06), never synchronously here.
    //
    // ITS CLAIM (phase 88, plan 88-07, BELT-06, D-09): the footprint it will take, unturned and
    // turned, registered by the send seam under the id it returns, so until this Place is
    // answered the one occupancy read counts those cells as taken: the ghost over them is red
    // (and a second drop there is still sent, flashing red, the ghost being advisory), and a
    // belt path through them is red and sends nothing.
    const { w: kindW, h: kindH } = catalogEntry(kind);
    const gestureId = sendInput(
      encodeGridCommand({
        kind: 'Place',
        kind_byte: kind,
        cell_x: cell.cx,
        cell_y: cell.cy,
      }),
      { claim: placeClaim(cell, kindW, kindH, rot, isWireObstacle(kind)) },
    );
    // Repeat placement (IX-06 / WR-A): a rapid burst can send several Places before
    // any is answered. Record THIS placement as its OWN entry, keyed by the gesture id
    // its send returned, so its Rotates wait for its own accept and a refusal of
    // another Place never reaches them (D-06). IX-05 honesty: the NEUTRAL waiting
    // shimmer marks the placed cell (not a build-blue "placed" ghost) until this
    // Place's verdict ends it. It is display-only and never reads as success.
    //
    // An id of 0 is nothing sent (no transport, phase 88 review IN-05): no verdict will answer
    // it, so no entry waits and no shimmer marks it, and no verdict naming id 0 (a raw frame,
    // 16-router-presets) can pair with one.
    if (gestureId !== 0) {
      const entry: PendingPlacement = {
        gestureId,
        cell,
        kind,
        dims: ghostDims(kind, rot),
        rotCount: rot,
        emitTick: getScene().tick,
        presetMedium,
        abandoned: false,
        accepted: null,
      };
      pendingPlacements.push(entry);
      showShimmerOf(entry);
      ensureEchoWatch();
    }
    // IX-06: STAY ARMED — re-render the follow-ghost at the cursor for the next
    // placement (placementKind is unchanged).
    ghost.moveTo(p.x, p.y);
  };

  // ---- select (press on a node or a belt tile) -----------------------------
  // A press on a node or a belt tile is a candidate SELECT: press-then-release
  // (no meaningful drag) selects it. Selection is DISCRIMINATED (RESEARCH
  // Finding 6): a node gets the outline + rotate handle; a belt gets endpoint
  // grab handles (CTRL-01). The EXTERNAL GestureController contract is
  // preserved exactly: selectedId() returns the node handle ONLY when a node is
  // selected — a selected belt reads as null so App's onSelect flow stays
  // node-scoped. `r` stays a no-op on a belt selection (UI-SPEC A19); the Delete key
  // on a selected belt routes to `requestBeltDelete` (phase 89, D-07), the belt's own
  // guarded path, never to the machine one.
  let down: { kind: 'node' | 'belt'; id: number } | null = null;
  let selection: { kind: 'node' | 'belt'; id: number } | null = null;

  /** The selected NODE handle, or null (a selected belt reads as null). */
  const selectedNode = (): number | null =>
    selection?.kind === 'node' ? selection.id : null;

  /**
   * THE ROT A SENT ROTATE WILL PRODUCE, per node, until the host shows it (plan 74.1-25,
   * the review's info line on `beltInTheTurn`, now `walkTheTurn`). The walk used to start
   * from the last ECHOED rot, so a second turn sent before the first echoed was predicted
   * as if the first had not happened. The host judges each Rotate from the rot the previous one
   * left, so the walk now starts from this record when one is held.
   *
   * ONLY A TURN THE WALK PREDICTS ACCEPTED IS RECORDED. A refused Rotate (a belt or a
   * machine in the way) produces no rot, and the host judges the next one from the same
   * place; recording it would make a second R on a blocked machine flash nothing while the
   * host refuses it again. The walk that predicts the refusal is the walk that decides
   * whether there is a rot to remember, so the two cannot disagree.
   *
   * A record dies when a packet shows the node at that rot (`refreshSelection`, and here
   * on read), on a keyframe (`clearSelection`: handles are reminted), or once the sim has
   * run `ECHO_TTL_TICKS` past the send, the same backstop every echo watcher in this file
   * uses for a command whose echo never comes (a turn the host refused for a reason the
   * walk does not mirror, such as the grid's edge).
   *
   * MEASURED, AND WORTH SAYING: the host keeps the anchor, so a turned box alternates
   * between two shapes, and the cells a turn from the pending rot meets beyond its own box
   * are cells the stale scene still shows the machine owning. On a real board nothing else
   * can stand there before the echo, so the two predictions differ only on a constructed
   * board; the record makes the walk the host's walk rather than the same answer by luck.
   */
  const pendingRots = new Map<number, { rot: number; emitTick: number }>();

  /** The rot the host will judge node `n`'s next Rotate from (see {@link pendingRots}). */
  const judgedRot = (n: NodeView): number => {
    const p = pendingRots.get(n.id);
    if (!p) {
      return n.rot;
    }
    // Only playing ticks count (phase 88, D-07): `onResume` restarts the count at Resume.
    if (n.rot === p.rot || (isPlaying() && getScene().tick > p.emitTick + ECHO_TTL_TICKS)) {
      pendingRots.delete(n.id);
      return n.rot;
    }
    return p.rot;
  };

  /**
   * What a Rotate of machine `id` would meet FIRST, and the rot it would produce, or null
   * for an unknown node. Plan 74.1-18's `beltInTheTurn` answered only "which belt tile, or
   * null"; plan 74.1-25 renamed it for what it now answers, because the pending-rot record
   * needs a clear turn told apart from a turn a machine blocks, and walks it from the
   * judged rot. A belt first is the flash; a machine first, or nothing in the way, marks
   * nothing, because a flash on a belt the host did not stop at would point at the wrong
   * thing.
   *
   * THE HOST'S WALK, MIRRORED: the `Rotate` arm (`command.rs`) keeps the anchor, expands
   * the turned box with `cells_of_footprint` (row-major from the anchor), skips the cells
   * the machine itself owns, and stops at the FIRST cell another node owns. A belt tile
   * there is `RotateCoversBelt`; a machine there is `FootprintCollision`. This walks the
   * same cells in the same order through the shared `cellsOfFootprint` mirror and reads
   * the same occupancy pair the rest of this file uses (`nodeAtCell ?? beltAtCell`), so
   * the tile it names is the tile the host's refusal is about. The machine's OWN cells are
   * its box at the judged rot, which is what the host holds when it judges; a cell the
   * stale scene still shows it owning outside that box is free to the host, so only a
   * belt there counts.
   *
   * ONE GAP, stated: the host checks the grid bound before occupancy on every cell, and
   * the frontend carries no mirror of that bound, so a turn whose box leaves the grid
   * BEFORE it meets a belt would flash the belt while the host says the cell is past the
   * edge. That needs a machine turned against the grid's edge with a belt behind it.
   */
  type TurnMeets = { kind: 'clear' } | { kind: 'machine' } | { kind: 'belt'; cell: CellCoord };
  const walkTheTurn = (id: number, ccw: boolean): { newRot: number; meets: TurnMeets } | null => {
    const scene = getScene();
    const n = scene.nodes.get(id);
    if (!n) {
      return null;
    }
    const fromRot = judgedRot(n);
    const newRot = ccw ? (fromRot + 3) & 3 : (fromRot + 1) & 3;
    const own = new Set(
      [...cellsOfFootprint(n.cell_x, n.cell_y, n.w, n.h, fromRot)].map(([x, y]) => `${x},${y}`),
    );
    for (const [cx, cy] of cellsOfFootprint(n.cell_x, n.cell_y, n.w, n.h, newRot)) {
      if (own.has(`${cx},${cy}`)) {
        continue;
      }
      const machine = nodeAtCell(scene, cx, cy);
      if (machine !== undefined && machine.id !== id) {
        return { newRot, meets: { kind: 'machine' } };
      }
      if (beltAtCell(scene, cx, cy) !== undefined) {
        return { newRot, meets: { kind: 'belt', cell: { cx, cy } } };
      }
    }
    return { newRot, meets: { kind: 'clear' } };
  };

  /**
   * THE ONE ROTATE SEND (plan 74.1-25, review WR-04): the R and Shift+R keys and the
   * rotate-handle release both turn a selected machine through here, so both show which
   * belt is in the way. Before this, only the key path flashed, and a handle click left
   * "Move that belt first." pointing at nothing.
   *
   * The Rotate is SENT whatever the walk finds (Phase 64 D-07: the host is the judge, and
   * its typed `RotateCoversBelt` says WHY in words); the walk only marks WHICH belt, at the
   * flash's one duration (UI-SPEC 6.4; FINDING R1, a default the maintainers can
   * overturn: one flash language across the app, and the sentence names the cause), and
   * records the rot a turn it predicts accepted will produce ({@link pendingRots}).
   */
  const sendRotate = (node: number, ccw: boolean): void => {
    const walk = walkTheTurn(node, ccw);
    sendInput(encodeGridCommand({ kind: 'Rotate', node, ccw }));
    if (walk === null) {
      return;
    }
    if (walk.meets.kind === 'belt') {
      overlay.showRejectFlash(walk.meets.cell, { w: 1, h: 1, rot: 0 });
    } else if (walk.meets.kind === 'clear') {
      pendingRots.set(node, { rot: walk.newRot, emitTick: getScene().tick });
    }
  };

  /** Camera zoom scale WITHOUT touching Camera: the world->screen x-delta. */
  const camScale = (): number =>
    cam.worldToScreen(1, 0).x - cam.worldToScreen(0, 0).x;

  // ---- rotate handle (CTRL-03 / D-13, UI-SPEC section 5) --------------------
  // The overlay pins the handle to the selection outline's top-right corner;
  // this layer hit-tests it (12px zoom-compensated radius, the shared
  // nubHitRadiusWorld policy) and emits the SAME Rotate frame as the keyboard
  // path. Click = CW, Shift+click = CCW (mirrors Shift+R).
  const rotateHandleHit = (sx: number, sy: number): boolean => {
    if (selection?.kind !== 'node') {
      return false;
    }
    const c = overlay.rotateHandleCenter();
    if (!c) {
      return false;
    }
    const w = cam.screenToWorld(sx, sy);
    const r = nubHitRadiusWorld(camScale());
    const dx = c.x - w.x;
    const dy = c.y - w.y;
    return dx * dx + dy * dy <= r * r;
  };

  /** A press consumed by the rotate handle (no pan, no reselect) awaiting its up. */
  let rotatePress: { node: number } | null = null;
  let rotateHover = false;
  const clearRotateHover = (): void => {
    if (!rotateHover) {
      return;
    }
    rotateHover = false;
    overlay.setRotateHandleHover(false);
    if (canvas.style.cursor === 'pointer') {
      canvas.style.cursor = '';
    }
  };

  /**
   * The two belt ends, in `Tail`-then-`Head` order, which is the order the CORE
   * declares a belt's two ports in (`Role::In` first) and therefore the order this
   * file enumerates them in wherever both are walked. `nubsInRadius` sorts by distance
   * afterwards, and its sort is stable, so two ends at an identical distance keep this
   * enumeration order rather than an incidental one.
   */
  const BELT_ENDS: readonly BeltEnd[] = ['Tail', 'Head'];

  /**
   * One reachable nub: its node, its port, the nub center, and the squared pointer
   * distance the ranking is ordered by.
   *
   * `node` IS NULLABLE SINCE PHASE 74, and the null is a BELT END. A belt is a ported
   * node in the core from 74-02 on, but it reaches the wire as a `BeltView` with no
   * `NodeView` and (D-05) no `ports` member, so there is no node record to carry here
   * and fabricating one would put a made-up footprint, cell and rotation into the hit
   * set. `handle` is what every consumer actually needed from it: the DENSE HANDLE the
   * `Dock` / `DrawWire` command names, which `command.rs` resolves for a belt exactly
   * as it resolves one for a machine. The two `bodyOfNode` readers on the wire path
   * still need the record itself, and they are on the path that takes no belt ends.
   */
  interface NubHit {
    node: NodeView | null;
    /** The dense handle a command names: the node's id, or the belt's id. */
    handle: number;
    port: PortView;
    x: number;
    y: number;
    d2: number;
  }

  /**
   * WHAT `nubsInRadius` SCANS. `'ports'` is every machine port nub and is the shipped
   * set; `'ports+belt-ends'` adds every belt's two spatial END nubs (LINK-02/LINK-10).
   *
   * IT IS A PARAMETER ON THE ONE LOOP, NOT A SECOND SCAN, for the reason the loop's own
   * docblock gives: a copied loop is how two hit tests start disagreeing about
   * reachability, and this file already records two documented bugs from that drift
   * class. It defaults to the shipped set, which readers 1, 5 and 6 read.
   *
   * TWO READERS OPT IN. The handle-drag drop ranker (reader 2, since phase 74.1), which
   * asks "what can this dragged end land on" and keeps its drop rings on the end tile
   * centre (74-UI-SPEC 3.3). And since phase 89 (D-06, WINDOWS 248) the belt draw RELEASE
   * (reader 4, `headInAt`, the Head decision the preview and the release share), which
   * keeps only role-In hits, so a belt's TAIL end is a Head target and its Head end is not.
   * The Belt-armed PRESS used to be a reader; since 74.1 it resolves BY CELL on the
   * doorstep tile (`doorstepPressHit`) and reads no disc at all, so belt ends are in no
   * press path through this scan. The others stay out:
   *
   *   - reader 1, the idle nub hover, must NOT take belt ends: it paints at REST, and
   *     D-07 is that a belt end wears a mark only while the Belt tool is armed or the
   *     belt is selected.
   *   - reader 4 USED TO stay out, on the argument that a belt-end hit would auto-append a
   *     facing cell and emit a SECOND `Dock` on the gesture LINK-10 defines as emitting
   *     exactly one. Neither holds for the Head dock: a belt target appends nothing (it is
   *     judged by the one-step rule, `beltTarget`), and the second Dock is the Head's own,
   *     while LINK-10 owns the Tail (its one Dock is the pressed Head's). The cost of staying
   *     out was WINDOWS 248: a draw finished on another belt's start went red or undocked.
   *   - reader 6, the REVERSED draw's Tail (`tailOutAt`, phase 89 D-02), takes machine Out
   *     and Fault nubs only; a free belt Head is found there by its doorstep, through the
   *     press lookup, as LINK-10 finds it.
   *   - reader 5, the armed WIRE tool, must NOT take them, and that one is a named
   *     high-severity threat (T-74-22) rather than a preference: it is the only caller
   *     passing `wireNubHitRadiusWorld` = 22, and at 22 world px the hit circles of two
   *     abutting end tile centres (`CELL` = 32 apart) overlap in a 12 px band straddling
   *     the seam - the one band a user aiming at a junction actually presses in.
   */
  type NubScan = 'ports' | 'ports+belt-ends';

  /**
   * EVERY nub inside the given hit radius over ALL nodes' worldNubSpecs, NEAREST
   * FIRST - the ONE definition of which nubs the pointer can reach. `worldNubSpecs`
   * preserves port order, so `ports[i]` is the nub's port. The ranked dock-drag path
   * and the single-hit paths (idle hover, the port-to-port draw release) all read THIS
   * list, so they cannot disagree about reachability. The sort is stable
   * (ES2019), so nubs at an identical distance keep node-then-port enumeration order.
   *
   * SIX READERS as of phase 89 (five as of plan 66-06, and the fifth is why `radius` exists):
   *
   *   1. `nearestNub`            idle nub hover (D-10)                default radius
   *   2. the dock-drag ranker    belt end-handle drop candidates      default radius
   *   3. (retired in 74.1)       the belt draw PRESS now resolves by cell on the doorstep
   *                              tile through `doorstepPressHit`, not through this scan
   *   4. the belt draw RELEASE   the Head decision (`headInAt`)       default radius, + belt ends
   *   6. the reversed draw TAIL  `tailOutAt` (phase 89, D-02)          default radius
   *   5. the armed WIRE tool     press + move + release hit tests     wireNubHitRadiusWorld
   *
   * The parameter DEFAULTS to the shipped `nubHitRadiusWorld(camScale())`, so readers
   * 1 to 4 are byte-unchanged and the belt dock ranker Phase 64 stabilised is untouched.
   * The wire path passes the wider 66-06 radius EXPLICITLY at each of its three sites.
   *
   * A SECOND SCAN WAS THE ALTERNATIVE AND IT IS THE WRONG ONE. Copying this loop for
   * the wire path would falsify the sentence above ("the ONE definition"), and it is
   * precisely how the wire path and the dock path would start disagreeing about
   * reachability - the drift class this file already records two documented bugs
   * against. One loop, one parameter.
   */
  const nubsInRadius = (
    w: { x: number; y: number },
    radius: number = nubHitRadiusWorld(camScale()),
    scan: NubScan = 'ports',
  ): NubHit[] => {
    const scene = getScene();
    const r = radius;
    const hits: NubHit[] = [];
    for (const node of scene.nodes.values()) {
      const specs = worldNubSpecs(node);
      for (let i = 0; i < specs.length; i++) {
        const s = specs[i];
        const d2 = (s.x - w.x) * (s.x - w.x) + (s.y - w.y) * (s.y - w.y);
        if (d2 <= r * r) {
          hits.push({ node, handle: node.id, port: node.ports[i], x: s.x, y: s.y, d2 });
        }
      }
    }
    if (scan === 'ports+belt-ends') {
      // THE SAME LOOP, ONE LEVEL ON. A belt end's spatial port comes from `beltEndPort`,
      // the frontend twin of the host's `belt_end_world`, so it arrives in `PortView`
      // shape and every downstream reader - `acceptsDock`, the dock ranker, the
      // port-to-port seed - judges it with the code it already had. A single-tile belt
      // answers null there and is simply absent from the set, which is the host's own
      // answer rather than a client gate.
      //
      // THE HIT POINT IS THE END TILE CENTRE, `cell * CELL + HALF`, and it is the same
      // point the handle-drag DROP rings are centred on (74-UI-SPEC 3.1, unchanged by
      // 74.1, whose doorstep anchor applies to the Belt-armed press path and its resting
      // ring only, never to this scan). It is also the point the T-74-22
      // radius argument is measured against: two abutting end tile centres are exactly
      // `CELL` apart. A belt-to-belt docked end draws its grab dot at the SEAM instead
      // (`beltHandlePoints`), which is `hitHandle`'s question - "which of MY handles did
      // I grab" - and not this one, which is "what can this gesture land on".
      for (const belt of scene.belts.values()) {
        for (const end of BELT_ENDS) {
          const port = beltEndPort(belt.tiles, end);
          if (!port) {
            continue;
          }
          const x = port.cell_x * CELL + CELL / 2;
          const y = port.cell_y * CELL + CELL / 2;
          const d2 = (x - w.x) * (x - w.x) + (y - w.y) * (y - w.y);
          if (d2 <= r * r) {
            hits.push({ node: null, handle: belt.id, port, x, y, d2 });
          }
        }
      }
    }
    hits.sort((a, b) => a.d2 - b.d2);
    return hits;
  };

  /**
   * The nearest reachable nub, or null — DEFINED as the first element of
   * {@link nubsInRadius} rather than a second scan of its own, so "which nubs
   * are reachable" has exactly one answer in this file. Used by the idle nub
   * hover (D-10) and both port-to-port draw endpoints; the dock drag ranks the
   * whole list instead (drift A).
   */
  const nearestNub = (w: { x: number; y: number }, scan: NubScan = 'ports'): NubHit | null =>
    nubsInRadius(w, nubHitRadiusWorld(camScale()), scan)[0] ?? null;

  /**
   * THE TRIM (phase 89, D-03 and D-06, UI-SPEC 1.3 and 3.2): the drawn cells with the trailing
   * cells that belong to the release target dropped, at the HEAD of the walk only. A target's
   * dot straddles its edge, so a hand released on the inner half of a machine's dot has walked
   * into that machine's own cell (walk branch d pushes it on purpose), and a hand released on
   * another belt's first tile has walked onto that tile. Neither cell is part of the belt the
   * user meant: the dot is a target over its whole disc.
   *
   * WHAT IT MAY DROP, AND NOTHING ELSE (the plan's prohibition): a cell of the hit MACHINE's own
   * footprint, or the hit BELT's end tile (its Tail tile for a Head dock), and only while it is
   * the last drawn cell. A path that crosses a machine before the head keeps that crossing, so
   * it stays red; a path that walked deeper into a target belt than its end tile is not trimmed.
   * The seed is never dropped.
   */
  const trimAtTarget = (drawn: [number, number][], h: NubHit): [number, number][] => {
    const out = drawn.slice();
    const isLast = (cx: number, cy: number): boolean => {
      const last = out[out.length - 1];
      return last[0] === cx && last[1] === cy;
    };
    if (h.node !== null) {
      const n = h.node;
      const own = new Set(cellsOfFootprint(n.cell_x, n.cell_y, n.w, n.h, n.rot).map(([x, y]) => `${x},${y}`));
      while (out.length > 1 && own.has(`${out[out.length - 1][0]},${out[out.length - 1][1]}`)) {
        out.pop();
      }
    } else if (out.length > 1 && isLast(h.port.cell_x, h.port.cell_y)) {
      out.pop();
    }
    return out;
  };

  /**
   * WR-09's doorstep append, for a MACHINE target: the trimmed path plus the port's doorstep when
   * the head is one step short of it and the appended path stays legal (facing cell free, no
   * self-cross); otherwise the path unchanged. A belt target appends nothing: a belt end is
   * judged by the one-step rule, not the doorstep (plan 74.1-15).
   */
  const appendDoorstep = (path: [number, number][], h: NubHit): [number, number][] => {
    if (h.node === null) {
      return path;
    }
    const f = doorstepCell(h.port);
    const last = path[path.length - 1];
    const appended: [number, number][] = [...path, f];
    return Math.abs(f[0] - last[0]) + Math.abs(f[1] - last[1]) === 1 && beltPathLegal(appended) ? appended : path;
  };

  /**
   * THE TAIL-TAKEN TERM for the auto-dock (phase 89, D-06): true when `belt`'s TAIL already
   * holds a dock or a queued one names it. A Tail is never "taken" for an aimed drop (any number
   * of links may target it, which is how a fan-in is built, {@link headTaken}), but the auto-dock
   * is a join nobody aimed at, so it never makes a fan-in (the caution D-08 states for a turn).
   */
  const tailTaken = (belt: BeltView, scene: SceneState): boolean =>
    belt.docks.some((d) => d.end === 'Tail') ||
    (scene.queuedClaims?.beltEndTaken(belt.id, 'Tail', scene.generation) ?? false);

  /**
   * THE AUTO-DOCK (D-14, widened by phase 89 D-06): the ONE target the routed head of `path`
   * faces, or null when there are none or two or more (no chooser). The candidates are every
   * machine In the host mirror accepts for that head (`dockCandidates`), and every belt TAIL that
   * is free ({@link tailTaken}), one step PAST the head along its travel, and FACING it (its
   * doorstep is the head cell, so the joined belt runs on straight): the belt twin of a machine
   * In whose doorstep the head is on. Each belt candidate also passes the host mirror
   * (`acceptsDock` with `beltTarget`).
   */
  const autoDockAt = (path: [number, number][]): { node: number; portIndex: number; drain: number } | null => {
    const r = route(path);
    if (!r.ok) {
      return null;
    }
    const scene = getScene();
    const head = beltEndCell(r.tiles, 'Head');
    const outward = beltEndOutward(r.tiles, 'Head');
    const cands: Array<{ node: number; portIndex: number; drain: number }> = dockCandidates(
      scene.nodes.values(),
      'Head',
      head,
      outward,
    ).map((c) => ({ node: c.node.id, portIndex: c.port.index, drain: oppositeSide(c.port.side) }));
    if (outward !== null) {
      for (const belt of scene.belts.values()) {
        if (tailTaken(belt, scene)) {
          continue;
        }
        const port = beltEndPort(belt.tiles, 'Tail');
        if (port === null) {
          continue;
        }
        if (port.cell_x !== head[0] + outward[0] || port.cell_y !== head[1] + outward[1]) {
          continue;
        }
        const [doorX, doorY] = doorstepCell(port);
        if (doorX !== head[0] || doorY !== head[1]) {
          continue;
        }
        if (!acceptsDock(port, 'Head', head, outward, beltTarget(belt.tiles, 'Tail'))) {
          continue;
        }
        cands.push({ node: belt.id, portIndex: port.index, drain: oppositeSide(port.side) });
      }
    }
    return cands.length === 1 ? cands[0] : null;
  };

  /**
   * THE HEAD DECISION OF A FORWARD DRAW, ONE CLOSURE WITH ONE CALLER, `committedDraw` (phase
   * 74.1 plan 08, rewritten by phase 89 plan 89-05 for D-03, D-04 and D-06): for the drawn cells
   * and a pointer WORLD point (null: nothing is in reach), which target the belt's Head docks,
   * the walk-order cells that commits, whether the host mirror accepts it, and the drain the
   * head is re-kinded with. Null when nothing is in reach and no auto-dock target exists (the
   * Head stays free).
   *
   * `committedDraw` is the one function the preview and the release both read, so this ranking
   * exists once: a second copy is how the ghost and the commit would start disagreeing about
   * which end the belt docks, the drift class this file records twice already.
   *
   * THE HIT SET: every In nub and every belt TAIL end inside the hit radius (`nubsInRadius`,
   * scan `'ports+belt-ends'`, role In: a belt's Tail end port is `Role::In`), nearest first.
   * Each hit is judged on the path it would COMMIT: the drawn cells TRIMMED of that target's own
   * cells at the head ({@link trimAtTarget}, D-03, D-06), then, for a Mechanical machine In, its
   * doorstep APPENDED when the head is one step short ({@link appendDoorstep}, WR-09). A machine
   * In is judged by the doorstep rule (`MACHINE_TARGET`), a belt Tail by the one-step rule
   * (`beltTarget(tiles, 'Tail')`), both through `acceptsDock`, the host mirror.
   *
   * THE RANKING (D-04, WINDOWS 249), in order:
   *   1. the nearest hit the host mirror ACCEPTS, with its trimmed path;
   *   2. else the ONE auto-dock target the routed head of the drawn path faces
   *      ({@link autoDockAt});
   *   3. only when neither exists, the NEAREST hit, sent so the host refuses it in words (Phase
   *      64, D-08: the prediction picks WHAT to send, never WHETHER). A wrong-medium In appends
   *      nothing, and a legal release flashes the hit's dot cell (WR-02, UI-SPEC A23).
   * THE TRIM IS FOR A DOT THAT DOCKS. Rules 2 and 3 commit the cells as walked (rule 3 with its
   * doorstep appended), never trimmed: a hand that went into a machine whose dot does not take
   * the belt is a hand on a machine body, red, and a trim there would send a belt whose head is
   * not under the hand, docked somewhere else, which is the silent wrong result the CORNER-01
   * matrix (`cornerMatrix.test.ts`) refuses everywhere on its grid.
   * Until phase 89 a non-accepting near miss came back as the hit before the auto-dock was ever
   * asked, so a neighbour's Electrical In beside the doorstep the head faced took the Head slot:
   * a Dock the host refused, and no dock to the In the belt actually reached.
   */
  const headInAt = (
    drawn: [number, number][],
    w: { x: number; y: number } | null,
  ): {
    /** The Head dock target: a machine's id or a belt's id, and the port's catalog index. */
    target: { node: number; portIndex: number };
    /** The walk-order cells this Head decision commits (trimmed, maybe appended). */
    path: [number, number][];
    /** The host mirror accepts the Head dock on `path`. */
    accepts: boolean;
    /** The flow into the target when accepted, for the Head seam; else null. */
    drain: number | null;
    /** The dot cell a legal release flashes: a last-resort Head the mirror refuses (A23). */
    flash: CellCoord | null;
  } | null => {
    const scene = getScene();
    const hits =
      w === null
        ? []
        : nubsInRadius(w, nubHitRadiusWorld(camScale()), 'ports+belt-ends').filter((h) => h.port.role === PORT_ROLE.IN);
    const judge = (h: NubHit) => {
      const mechanical = mediumsCompatible(h.port.medium, MEDIUM_MECHANICAL);
      // A wrong-medium In appends nothing (the path the player saw is the path that emits).
      const path = mechanical ? appendDoorstep(trimAtTarget(drawn, h), h) : drawn;
      // The path this hit commits if it is NOT accepted (rule 3): the trim is for a dot that
      // docks, so a refused hit keeps every walked cell (a hand inside a machine stays red).
      const asDrawn = mechanical ? appendDoorstep(drawn, h) : drawn;
      const belt = h.node === null ? scene.belts.get(h.handle) : undefined;
      const r = route(path);
      const accepts =
        r.ok &&
        (h.node !== null || belt !== undefined) &&
        acceptsDock(
          h.port,
          'Head',
          beltEndCell(r.tiles, 'Head'),
          beltEndOutward(r.tiles, 'Head'),
          belt === undefined ? MACHINE_TARGET : beltTarget(belt.tiles, 'Tail'),
        );
      let drain: number | null = null;
      if (accepts && r.ok) {
        // Into a machine In the flow runs against the side it faces; into a belt's Tail it runs
        // from the head tile onto the Tail tile, whichever way the head arrived.
        const [hx, hy] = beltEndCell(r.tiles, 'Head');
        drain = h.node !== null ? oppositeSide(h.port.side) : sideOfUnitDelta([h.port.cell_x - hx, h.port.cell_y - hy]);
      }
      return {
        target: { node: h.handle, portIndex: h.port.index },
        path,
        asDrawn,
        accepts,
        drain,
        // The dot's cell: flashed only when this hit is the last-resort Head (rule 3 below), on
        // a legal path (`onWinUp`), Electrical or not (UI-SPEC A23).
        flash: { cx: h.port.cell_x, cy: h.port.cell_y },
        // Whether this hit can be rule 3's last resort (review WR-B-02): a machine In always; a
        // belt start only when the hand is on that start's own end tile. The reach grows to 1.5
        // cells as the camera zooms out, and a draw released beside a belt start it does not face
        // was aimed at nothing, so it lays a free-ended belt silently, as before phase 89, rather
        // than a refused Dock and a sentence for a join nobody asked for.
        aimed: h.node !== null || (belt !== undefined && w !== null && inTile(belt.tiles, 'Tail', w)),
      };
    };
    const judged = hits.map(judge);
    const accepting = judged.find((j) => j.accepts);
    if (accepting !== undefined) {
      return { target: accepting.target, path: accepting.path, accepts: true, drain: accepting.drain, flash: null };
    }
    const auto = autoDockAt(drawn);
    if (auto !== null) {
      return { target: { node: auto.node, portIndex: auto.portIndex }, path: drawn, accepts: true, drain: auto.drain, flash: null };
    }
    const nearest = judged.find((j) => j.aimed);
    if (nearest === undefined) {
      return null;
    }
    return { target: nearest.target, path: nearest.asDrawn, accepts: false, drain: null, flash: nearest.flash };
  };

  /**
   * THE BELT-ARMED PRESS TARGET (phase 74.1, D-01, D-06, D-07): the port whose DOORSTEP
   * TILE is the pressed cell, or null. A cell lookup, not a disc.
   *
   * WHY A TILE AND NOT A RADIUS. Before 74.1 the press took the nearest nub inside a hit
   * disc, but the draw seeds on the doorstep, so a press on a belt end's ring landed one
   * cell BEHIND the seed and a machine nub press landed on either side of the machine
   * edge. The first pointer sample then walked into the pressed thing, and every turn
   * out of a port died. Any repair inside the accumulator had to invent a cell the
   * pointer never swept, which D-01 forbids. Resolving the press BY CELL makes the press
   * cell the seed cell by construction, at every zoom: the caller passes
   * `cam.screenToCell`, the same accessor the plain seed and the walk read. A disc
   * wider than the tile (`nubHitRadiusWorld` reaches 48 world px at MIN_ZOOM) would reach
   * the pressed node and the diagonal cells again; the cost of the tile, named in the
   * plan, is a target smaller than the 12 screen px floor at scales 0.25 and 0.5.
   *
   * THE PRESS SET EQUALS THE RING SET, TERM FOR TERM (74.1-11, review WR-04): role,
   * cell, occupancy, medium and Head-taken, the last two read from the same functions
   * `dockTargetPoints` reads. A ring is painted exactly where a press starts a connected
   * draw, and every other floor tile is a plain start. Each term is pinned by a named
   * test that reddens when it alone is removed:
   *   - ROLE: only an Out or Fault port starts a SOURCE-docked draw (a belt's Head is an
   *     Out). A free Mechanical In's doorstep is not a plain seed since phase 89 (D-02): when
   *     this lookup misses, {@link inDoorstepPressHit} resolves it and the draw is REVERSED
   *     (`startIn`), so the belt flows into the pressed In. This lookup runs FIRST, so a
   *     doorstep an Out and an In share resolves to the Out (UI-SPEC A10).
   *   - CELL: the port's {@link doorstepCell} equals the pressed cell.
   *   - OCCUPANCY (74.1-04, UI-SPEC 3.2 item 3): the doorstep holds no machine and no
   *     belt tile ({@link doorstepOccupied}, the pair the ring set reads). A press on an
   *     occupied doorstep falls through to the plain seed on that occupied cell, which is
   *     exactly a press on the occupant: red preview, nothing sent. The term moves ONE
   *     observable thing, the armed ring (without it the press paints an armed ring on a
   *     doorstep that wears no resting ring), so its case asserts `nubRingCalls`, not
   *     `sent` (Pitfall 5).
   *   - MEDIUM (74.1-11): the port is compatible with a Mechanical belt
   *     (`mediumsCompatible`, the ring set's own skip). An Electrical Out's free doorstep
   *     is a plain seed: one DrawBelt, no ring, no Tail dock.
   *   - HEAD-TAKEN (74.1-11): a belt Head that already carries a Head dock
   *     ({@link headTaken}) is no source. A Head docked SIDEWAYS to an In leaves its own
   *     doorstep free, so occupancy does not cover it; its doorstep is a plain seed.
   * WHY THE EARLIER "THE HOST ANSWERS IN WORDS" CHOICE WAS DROPPED. Until 74.1-11 this
   * lookup carried neither of the last two terms, deliberately: an Electrical Out and a
   * taken Head stayed pressable and the host refused the dock in a sentence (Phase 64,
   * D-08). That was costed when the press target was a 12 px disc on the machine edge.
   * Since 74.1 the target is the whole floor tile in front of the port, so the same
   * choice meant a user could not start an ordinary belt on that tile at all: the draw
   * committed, then a dock they never asked for was refused in words. A DROP still
   * emits onto an unringed target (the handle drag and the release), which is where the
   * words belong.
   *
   * SCAN ORDER IS THE TIE-BREAK. Every node port first, then every belt Head, each in Map
   * insertion order, first hit wins: a doorstep shared by a machine Out and a belt Head
   * resolves to the machine, deterministically.
   */
  const doorstepPressHit = (pressCell: CellCoord): NubHit | null => {
    const scene = getScene();
    const at = (node: NodeView | null, handle: number, port: PortView): NubHit | null => {
      if (port.role !== PORT_ROLE.OUT && port.role !== PORT_ROLE.FAULT) {
        return null;
      }
      const [cx, cy] = doorstepCell(port);
      if (cx !== pressCell.cx || cy !== pressCell.cy) {
        return null;
      }
      if (doorstepOccupied(scene, handle, port)) {
        return null;
      }
      if (!mediumsCompatible(port.medium, MEDIUM_MECHANICAL)) {
        return null;
      }
      return { node, handle, port, x: cx * CELL + CELL / 2, y: cy * CELL + CELL / 2, d2: 0 };
    };
    for (const node of scene.nodes.values()) {
      for (const port of node.ports) {
        const hit = at(node, node.id, port);
        if (hit) {
          return hit;
        }
      }
    }
    for (const belt of scene.belts.values()) {
      if (headTaken(belt, scene)) {
        continue;
      }
      const port = beltEndPort(belt.tiles, 'Head');
      if (!port) {
        continue;
      }
      const hit = at(null, belt.id, port);
      if (hit) {
        return hit;
      }
    }
    return null;
  };

  /**
   * THE FREE-INPUT TERM, ONE PREDICATE WITH TWO READERS (phase 89, D-02, UI-SPEC 1.1): true when
   * `port` is a machine In a belt can be drawn INTO from its doorstep: role In, compatible
   * with a Mechanical belt, and its doorstep holding no machine, no belt tile and no queued
   * claim ({@link doorstepOccupied}). An In already fed by a belt has that belt's Head tile on
   * its doorstep, so the occupancy term alone withdraws it. Read by the armed ring set
   * (`dockTargetPoints` branch c) and the press lookup ({@link inDoorstepPressHit}), so the
   * press set equals the ring set term for term, as {@link doorstepPressHit}'s docblock
   * requires of the source half.
   */
  const freeInDoorstep = (scene: SceneState, owner: number, port: PortView): boolean =>
    port.role === PORT_ROLE.IN &&
    mediumsCompatible(port.medium, MEDIUM_MECHANICAL) &&
    !doorstepOccupied(scene, owner, port);

  /**
   * THE REVERSED PRESS TARGET (phase 89, D-02, BELT-01): the machine In whose DOORSTEP TILE is
   * the pressed cell and which {@link freeInDoorstep} admits, or null. Asked only after
   * {@link doorstepPressHit} missed (UI-SPEC A10: Out and Fault first, then free belt Heads,
   * then In), so a doorstep an Out and an In share resolves to the Out. Machine ports only,
   * scanned in Map order, each node's ports in catalog order, first hit wins. A belt's Tail
   * end is an In too, but a draw pressed in front of a belt's start is a join LINK-10 and
   * D-06 make from the other end, so it is not offered here.
   */
  const inDoorstepPressHit = (pressCell: CellCoord): NubHit | null => {
    const scene = getScene();
    for (const node of scene.nodes.values()) {
      for (const port of node.ports) {
        const [cx, cy] = doorstepCell(port);
        if (cx !== pressCell.cx || cy !== pressCell.cy) {
          continue;
        }
        if (freeInDoorstep(scene, node.id, port)) {
          return { node, handle: node.id, port, x: cx * CELL + CELL / 2, y: cy * CELL + CELL / 2, d2: 0 };
        }
      }
    }
    return null;
  };

  /**
   * THE TAIL OF A REVERSED DRAW (phase 89, D-02, UI-SPEC 1.2): what the hand end of a draw
   * pressed on an input docks to, judged on the drawn cells (walk order, the hand last) and
   * the pointer. In order:
   *   1. the Out, Fault or free belt Head whose DOORSTEP is the hand's cell: the press lookup
   *      ({@link doorstepPressHit}) run on the release cell, so a reversed draw ends where a
   *      forward draw would have started, every term included;
   *   2. else an Out or Fault NUB inside the hit radius (`nubsInRadius`, machine ports), each
   *      judged on its own committed path (the walk TRIMMED of that machine's own cells and its
   *      doorstep APPENDED, {@link trimAtTarget} and {@link appendDoorstep}, UI-SPEC A22): the
   *      nearest one the host mirror accepts, and only when none accepts, the nearest, sent so
   *      the host refuses it in words (D-04's order, which has no auto-dock step at a Tail);
   *   3. else null: released on floor, the Tail is free.
   * `path` is the walk-order cells that end commits; `accepts` is the host mirror's answer for
   * the Tail dock on the REVERSED path, which is the path the release sends.
   */
  const tailOutAt = (
    drawn: [number, number][],
    w: { x: number; y: number } | null,
  ): { hit: NubHit; path: [number, number][]; accepts: boolean } | null => {
    const last = drawn[drawn.length - 1];
    const door = doorstepPressHit({ cx: last[0], cy: last[1] });
    if (door !== null) {
      return { hit: door, path: drawn, accepts: true };
    }
    if (w === null) {
      return null;
    }
    const hits = nubsInRadius(w).filter((h) => h.port.role === PORT_ROLE.OUT || h.port.role === PORT_ROLE.FAULT);
    const judge = (h: NubHit): { hit: NubHit; path: [number, number][]; accepts: boolean } => {
      // The same trim and append a forward Head gets (D-03, UI-SPEC A22): a hand released on the
      // inner half of an Out or Fault dot has walked into that machine's own cell; that cell is
      // dropped and the doorstep appended when the hand stopped one step short of it. As for a
      // Head, the trim is for a dot that docks: a refused hit keeps every walked cell.
      const mechanical = mediumsCompatible(h.port.medium, MEDIUM_MECHANICAL);
      const path = mechanical ? appendDoorstep(trimAtTarget(drawn, h), h) : drawn;
      const r = route([...path].reverse());
      const accepts =
        r.ok &&
        acceptsDock(h.port, 'Tail', beltEndCell(r.tiles, 'Tail'), beltEndOutward(r.tiles, 'Tail'), MACHINE_TARGET);
      return { hit: h, path: accepts ? path : mechanical ? appendDoorstep(drawn, h) : drawn, accepts };
    };
    const judged = hits.map(judge);
    return judged.find((j) => j.accepts) ?? judged[0] ?? null;
  };

  // ---- the taken-Out question, asked ONCE (plan 72-11, R-73) ---------------
  //
  // `node:port` for every Out that already sources a live wire, in the RAW catalog
  // keyspace `DrawWire` carries and `wires.ts` resolves through, so no translation
  // happens anywhere downstream.
  //
  // IT IS ONE DERIVATION WITH TWO READERS and that is the point rather than tidiness.
  // The resting-ring affordance withdraws a busy Handler's nubs (R-73) and the paired
  // ghost preview declines to promise a second cable to the same Handler (R-70); two
  // separate walks of `scene.wires` would be two answers to one question, and the board
  // could then offer a pairing the preview refuses, or the other way round.
  //
  // A STALE READ BY CONSTRUCTION, exactly as the resting ring has always been: the Out
  // can be claimed between this read and the release, by an undo, a redo or another
  // packet. Both readers are affordances and neither is a gate.
  const takenOutKeys = (scene: SceneState): Set<string> => {
    const taken = new Set<string>();
    for (const w of scene.wires.values()) {
      taken.add(`${w.from.node}:${w.from.port}`);
    }
    return taken;
  };

  // ---- the D-04 pairing, mirrored from the command layer -------------------
  //
  // THE SITE THIS MIRRORS: `crates/fabrico-command/src/command.rs`, `route_handler_pair`
  // (the R-51 predicate) and `first_electrical_port` beside it. Since plan 72-08 ONE
  // `DrawWire` between a Route and a Handler mints BOTH legs under one action id, and
  // `validate_normalize` returns the GROUP so no caller can express just the forward
  // leg. The preview has to promise the same group or it is promising a board the
  // release will not build.
  //
  // The Handler half is read off the KIND BYTE, not restated as a port-shape rule. The
  // host computes that byte through `is_handler_shape` (plan 72-06's R-37 naming rule)
  // before it ever reaches a render packet, so reading the byte IS reading that rule;
  // re-deriving the shape here would be a second copy of the predicate 72-06
  // deliberately kept in one crate.
  const isRouteShape = (n: NodeView): boolean => n.kind === machine_kind.ENDPOINT;
  const isHandlerShape = (n: NodeView): boolean => n.kind === machine_kind.HANDLER;
  const routeHandlerPair = (a: NodeView, b: NodeView): boolean =>
    (isRouteShape(a) && isHandlerShape(b)) || (isRouteShape(b) && isHandlerShape(a));

  /**
   * A node's FIRST electrical port with `role`, in declared index order, or null.
   * Mirrors `first_electrical_port` (`command.rs`): the paired legs are resolved from
   * the two nodes' DECLARATIONS and never from the drag's own ports, because the drag
   * names at most one of the two legs and a leg derived from a port the user did not
   * touch has to come from somewhere the user cannot skew.
   */
  const firstElectricalPort = (n: NodeView, role: number): PortView | null =>
    n.ports.find((pt) => pt.role === role && pt.medium === MEDIUM_ELECTRICAL) ?? null;

  /**
   * A Handler that can no longer answer anybody: its ONE electrical Out already sources
   * a wire, so the pairing D-04 exists to make is refused before it starts (R-73).
   *
   * `taken` is the SET THE CALLER ALREADY BUILT through `takenOutKeys`, passed in rather
   * than rebuilt, so the resting-ring withdrawal and the paired-ghost preview cannot end
   * up with two answers to "is this Out taken". A plain Factory with a busy electrical
   * Out is NOT a Handler and pairs with nothing, so nothing is withdrawn from it.
   */
  const handlerCannotPairAgain = (n: NodeView, taken: Set<string>): boolean => {
    if (!isHandlerShape(n)) {
      return false;
    }
    const out = firstElectricalPort(n, ROLE_OUT);
    return out !== null && taken.has(`${n.id}:${out.index}`);
  };

  /** One previewed corridor: the routed cells plus the D1 lane key for them. */
  interface GhostLeg {
    path: Array<{ cx: number; cy: number }>;
    lane: number;
  }

  /**
   * THE ONE EXPRESSION. Every ghost corridor this file draws - the drag's own leg and
   * the paired leg alike - is routed and keyed HERE, so there is exactly one
   * `wireRouteAvoiding(` call site and exactly one `cableLane(` call site in the gesture
   * layer.
   *
   * `cableLane.ts`'s own header states why that matters: if the ghost's lane key and the
   * landed cable's lane key were computed independently "the preview would promise a
   * corridor the landed cable does not take, which is precisely the failure that
   * disqualified the `fabrico-command` corridor offset". Two expressions that agree
   * today are not one expression. `wireRouteAvoiding` is the byte-pinned TS mirror of the
   * Rust router the host re-derives from the two docks on every packet, so preview ==
   * commit.
   *
   * THE MACHINE LIST (phase 92, D-09, CHROME-19). The landed cable goes around every third
   * machine in its way, so the ghost has to as well, and it has to read the SAME list: the
   * host routes every wire of a packet around the box of every node whose kind
   * `is_wire_obstacle` accepts (`render_packet.rs` `wire_obstacles`), and this reads the
   * last packet's nodes (`getScene().nodes`) through `bodyOfNode`, filtered by
   * `isWireObstacle`, the TS predicate `ts_wire_obstacle_mirror.rs` locks to the Rust one.
   * Belts and wires are not in `nodes` at all, and a Label is filtered out, so a cable
   * crosses all three in both callers. Neither caller needs node ids: the router drops every
   * box holding a dock cell itself, which also keeps a free drag's pointer-cell target from
   * being blocked by the machine under it.
   *
   * THE BOARD-TO-BE (review fix pass 1, WR-A-04, threat T-92-11). On a paused board a gesture
   * waits in the host queue until Play, and the landed cable is routed round the board the
   * queue folds into, so the ghost reads that board too: each queued Place's box is added
   * (`queuedClaims.wireBoard`, a machine kind only), each queued Delete's machine is dropped,
   * and a machine with a queued Rotate stands at the rot the turn will leave it at
   * (`judgedRot`, the record the rotate walk already keeps). A queued Undo or Redo cannot be
   * foreseen; UI-SPEC 4.1 rule 5 names it.
   */
  const ghostLeg = (
    from: { cell: [number, number]; side: number; body: WireBody },
    to: { cell: [number, number]; side: number; body: WireBody },
  ): GhostLeg | null => {
    const scene = getScene();
    const queued = scene.queuedClaims?.wireBoard(scene.generation);
    const machines: WireBody[] = [];
    for (const n of scene.nodes.values()) {
      if (isWireObstacle(n.kind) && queued?.deleted.has(n.id) !== true) {
        machines.push(bodyOfNode({ ...n, rot: judgedRot(n) }));
      }
    }
    if (queued !== undefined) {
      machines.push(...queued.boxes);
    }
    const r = wireRouteAvoiding(from, to, machines);
    if (!r.ok) {
      return null;
    }
    return {
      path: r.geometry.tiles.map((t) => ({ cx: t.cell_x, cy: t.cell_y })),
      lane: cableLane(r.geometry.tiles),
    };
  };

  /**
   * What the RELEASE will actually mint, as far as the pairing is concerned (R-70).
   *
   *   - `none`     : the two machines do not pair, so this drag mints ONE wire and the
   *                  preview shows ONE corridor. Route-to-Router, Router-to-Router and
   *                  Router-to-Route all land here, and so does a plain Factory: the
   *                  pairing is NARROW on purpose, because a machine that emits no
   *                  `Effect::Reply` cannot answer, and a return leg drawn back to one
   *                  would be a cable that can never carry anything.
   *   - `pair`     : both legs will land. Preview both corridors.
   *   - `refused`  : the two machines pair, but the return leg cannot be minted, so
   *                  72-08's R-52 refuses the WHOLE command and NOTHING lands.
   *
   * THE `refused` ARM IS WHY THIS RETURNS A VERDICT AND NOT JUST A LEG. D-02 gives the
   * Handler ONE electrical Out, so a Handler already answering a Route cannot be paired
   * with a second: the return leg is refused `PortOccupied` at `command.rs` step 6 and
   * the forward leg goes with it. Two blue corridors would promise two cables and one
   * blue corridor would promise one; the honest preview is the shipped "this release
   * mints nothing" colour. R-73 withdraws the resting ring so this is the BACKSTOP
   * rather than the ordinary experience, but the affordance is not a gate and a user
   * who drags here anyway is still owed a truthful corridor.
   */
  type PairPreview =
    | { kind: 'none' }
    | { kind: 'refused' }
    | { kind: 'pair'; leg: GhostLeg; nubs: CableNubs };
  const pairPreview = (
    source: { node: number },
    target: { node: NodeView },
  ): PairPreview => {
    const scene = getScene();
    const srcNode = scene.nodes.get(source.node);
    if (!srcNode || !routeHandlerPair(srcNode, target.node)) {
      return { kind: 'none' };
    }
    // The OTHER leg of the same pairing: the target's first electrical Out back to the
    // source's first electrical In. That is `Handler Out -> Route In` on a drag made
    // from the Route, and `Route Out -> Handler In` on the drag made the other way
    // round, which is why direction never has to be tested here.
    const from = firstElectricalPort(target.node, ROLE_OUT);
    const to = firstElectricalPort(srcNode, ROLE_IN);
    if (!from || !to) {
      return { kind: 'refused' };
    }
    if (takenOutKeys(scene).has(`${target.node.id}:${from.index}`)) {
      return { kind: 'refused' };
    }
    // THIS IS THE J-7 CABLE: the D-04 return leg, Handler.Out -> Route.In. Both
    // `NodeView`s are already in hand, so both bodies are the resolved rectangles
    // the host packet carries, derived through the ONE rot decode (`bodyOfNode`).
    const leg = ghostLeg(
      { cell: [from.cell_x, from.cell_y], side: from.side, body: bodyOfNode(target.node) },
      { cell: [to.cell_x, to.cell_y], side: to.side, body: bodyOfNode(srcNode) },
    );
    // The return leg's two ENDS are the same two ports it is routed between (plan 75-05,
    // D-08), built by `nubEndAt`, so the paired corridor runs nub to nub like the cable
    // the release will land.
    return leg
      ? {
          kind: 'pair',
          leg,
          nubs: {
            from: nubEndAt(from.cell_x, from.cell_y, from.side),
            to: nubEndAt(to.cell_x, to.cell_y, to.side),
          },
        }
      : { kind: 'refused' };
  };

  /**
   * The RESTING wire affordance's point list (WIRE-05, UI-SPEC 6.2, plan 66-06):
   * every electrical nub the armed Wire tool can address, in node-then-port order,
   * with the grabbed source flagged `filled`.
   *
   * THIS IS THE ANSWER TO WINDOWS ROW 113 AND IT IS NOT COPY. Row 113 is a user who
   * dragged an Out nub at a target they could not find, repeatedly, with no preview and
   * no message. The wider radius (see the press branch) makes the nub reachable; THIS
   * makes it findable, because arming the tool lights every place a wire can start
   * BEFORE any press. The shipped `showNubRing` cannot do that job: it appears only
   * once the pointer is already inside the radius, which is after you have succeeded.
   *
   * A PURE PROJECTION OF THE LIVE SCENE, RECOMPUTED, NEVER CACHED (T-66-06-02).
   * `scene.nodes` holds DENSE render handles, so a full keyframe rebuilds that table
   * from zero. A list captured at arm time would keep painting rings at stale
   * positions with no gesture and no warning. Recomputing on every armed move makes
   * the affordance immune to the remint BY CONSTRUCTION, which is the same reasoning
   * the D1 lane key uses to avoid needing a wire identity.
   *
   * THE RULES, from UI-SPEC 6.2, in the order they are applied:
   *
   *   - electrical only. A mechanical port can never carry a wire, so ringing one
   *     would promise a connection the host refuses (MediumMismatch).
   *   - In and Out only. Role 2 (Fault) is a belt-path exit and not a wire terminal.
   *   - before a press: every remaining nub rings, EXCEPT an Out already carrying a
   *     wire (see the occupancy note below).
   *   - after a press: the grabbed Out is FILLED, every In keeps its ring, and every
   *     other Out drops its ring, so the board stops offering a second start.
   *
   * THE OCCUPIED-OUT DROP IS AN AFFORDANCE AND NEVER A GATE (D-07/D-08). An Out that
   * already sources a wire can only be refused `PortOccupied` at host step 6, so
   * ringing it would be a lie. It stays PRESSABLE: the press acquires it, the drag
   * runs, the release emits, and the host answers in words. It has to be that way,
   * because this read is a STALE READ BY CONSTRUCTION - the Out can be claimed between
   * this paint and the release, by an undo, a redo, or another packet - so a client
   * gate here would swallow gestures on state it cannot vouch for. `wire.from.port` is
   * the RAW catalog index, the same keyspace `DrawWire` carries and `wires.ts`
   * resolves through, so no translation happens here.
   */
  const wireTargetPoints = (): Array<{ x: number; y: number; filled: boolean }> => {
    const scene = getScene();
    const takenOuts = takenOutKeys(scene);
    const dragging = wireSource !== null;
    const pts: Array<{ x: number; y: number; filled: boolean }> = [];
    for (const node of scene.nodes.values()) {
      const specs = worldNubSpecs(node);
      for (let i = 0; i < specs.length; i++) {
        const port = node.ports[i];
        if (!mediumsCompatible(port.medium, MEDIUM_ELECTRICAL)) {
          continue;
        }
        if (port.role === ROLE_OUT) {
          const isSource =
            wireSource !== null &&
            wireSource.node === node.id &&
            wireSource.portIndex === port.index;
          if (isSource) {
            pts.push({ x: specs[i].x, y: specs[i].y, filled: true });
          } else if (!dragging && !takenOuts.has(`${node.id}:${port.index}`)) {
            pts.push({ x: specs[i].x, y: specs[i].y, filled: false });
          }
        } else if (port.role === ROLE_IN) {
          // THE WITHDRAWAL, AND IT IS THE SAME QUESTION THE OUT BRANCH ASKS (R-73, D-02,
          // UI-SPEC 5.5). A Handler declares ONE electrical Out, so a Handler already
          // answering a Route cannot be paired with a second: 72-08's R-52 refuses the
          // WHOLE command, forward leg included, and nothing lands. Ringing its In would
          // invite exactly that gesture.
          //
          // THE GESTURE IS NOT OFFERED RATHER THAN REFUSED AFTER THE FACT, and that is
          // why this phase mints no second refusal tag. `PortOccupied`'s shipped
          // sentence is TRUE of the second pairing and names a control the panel really
          // has, but it talks about an output the user never dragged from. Withdrawing
          // the ring makes it the BACKSTOP for someone who releases here anyway instead
          // of the ordinary experience; rewording it would cost widening the wire
          // refusal union for a path the user should not be on.
          //
          // STILL AN AFFORDANCE AND STILL NOT A GATE, exactly like the occupied-Out drop
          // above: the nub stays pressable, the release still emits, and the host
          // answers in words. The read is stale by construction and a client gate on
          // state it cannot vouch for would swallow gestures.
          if (handlerCannotPairAgain(node, takenOuts)) {
            continue;
          }
          pts.push({ x: specs[i].x, y: specs[i].y, filled: false });
        }
      }
    }
    return pts;
  };

  /** Repaint the resting affordance from the CURRENT scene and drag state. */
  const paintWireTargets = (): void => {
    overlay.showWireTargets(wireTargetPoints());
  };

  /**
   * THE DROP PREDICATE (plan 74.1-25, review WR-03 and finding N4-RING): whether the HOST
   * will join the selected belt `carrier`'s `end`, where it lies now, to `port`. Two
   * readers, the drop ranker (`updateDropCandidate`, which colours the drop ring with it)
   * and the handle-drag rings (`dockTargetPoints` case 2), so the ring under the pointer
   * and the rings at rest can never tell the user two different things.
   *
   * THE GEOMETRY IS `acceptsDock` (role, adjacency by the target's shape, facing, medium),
   * read and never restated. THE THREE OCCUPANCY TERMS mirror the host's occupancy arm (its
   * belt-end half, `BeltEndTaken` since plan 74.1-32, `PortOccupied` before it), which
   * `acceptsDock` never carried:
   *   - a dragged HEAD that already carries a Head dock ({@link headTaken} on the carrier)
   *     accepts nowhere: a Head has at most one outgoing link, and the host refuses every
   *     second one (`a_second_head_dock_is_refused_and_the_first_join_survives_byte_for_byte`);
   *   - a target belt HEAD that already carries a Head dock does not take a Tail drop, for
   *     the same reason seen from the other belt (the resting rings already skipped it;
   *     the drop ring now agrees);
   *   - a machine Out or Fault that some belt's Tail dock already names does not take a
   *     Tail drop ({@link machineSourceTaken}, plan 74.1-33): the host's Tail arm finds the
   *     existing link and refuses `PortOccupied`.
   * WHY THE THIRD TERM EXISTS (review round 4 WR-02). This docblock used to say a machine
   * Out needed none, because a linked Out's doorstep holds the linking belt's end tile and
   * no OTHER carrier can stand there. That missed the linking belt itself: a selected
   * belt's Tail docked to an Out sits on that doorstep, so role, adjacency, facing and
   * medium all pass, and the commonest drag there is painted an accepting ring on the
   * very Out it is plugged into. A Fault adds a case adjacency never covered: a box's
   * second Fault has its own doorstep, but shares the first one's link key.
   *
   * A PREDICTION AND NEVER A GATE (D-07): it ranks and colours. Every release over a
   * reachable target still sends exactly one Dock, and the host answers in words.
   */
  const dropAccepts = (
    carrier: BeltView,
    end: BeltEnd,
    port: PortView,
    target: DockTargetShape,
    targetBelt: BeltView | null,
    targetNode: NodeView | null,
  ): boolean => {
    const scene = getScene();
    if (end === 'Head' && headTaken(carrier, scene)) {
      return false;
    }
    if (targetBelt !== null && port.index === BELT_PORT_HEAD && headTaken(targetBelt, scene)) {
      return false;
    }
    if (end === 'Tail' && targetNode !== null && machineSourceTaken(scene, targetNode, port)) {
      return false;
    }
    return acceptsDock(
      port,
      end,
      beltEndCell(carrier.tiles, end),
      beltEndOutward(carrier.tiles, end),
      target,
    );
  };

  /**
   * THE BELT TOOL'S TARGET POINTS (LINK-02 / LINK-10, 74-UI-SPEC 1.2 and 3.1).
   *
   * WINDOWS 140 is the wire affordance's row 113 for the other tool: a user dragged a
   * belt end onto another belt's end on the real binary and got no dock and no visible
   * refusal. Half of that was the model - belt ends were not in the hit set at all -
   * and this is the other half: nothing ever told the user where a drop could land.
   *
   * TWO PAINT CONDITIONS, AND D-07 ALLOWS NO THIRD. A belt end wears a mark only while
   * the Belt tool is ARMED or the belt is SELECTED, never at rest, which is why the two
   * shipped pixel-guard baselines cannot move.
   *
   *   1. the Belt tool is ARMED: every FREE belt-draw SOURCE rings on its DOORSTEP
   *      ({@link doorstepCell}), the empty floor cell the port feeds, because that is
   *      where the press resolves and where the new belt starts (`doorstepPressHit`).
   *      Two kinds of source wear the same ring (D-04, D-05), scanned in the press
   *      lookup's order, nodes first:
   *        a. a machine port whose role is Out or Fault AND whose medium is Mechanical
   *           AND whose doorstep is unoccupied (74.1-04);
   *        b. a belt HEAD that carries no Head dock (`headTaken`) AND whose doorstep is
   *           unoccupied. Only Heads, because LINK-10's release joins the NEW belt's
   *           Tail to the pressed belt's Head and a ring on a Tail would offer a join
   *           the release does not make. A single-tile belt has no Head port and so no
   *           ring.
   *        c. (phase 89, D-02) a machine IN whose medium is Mechanical AND whose doorstep is
   *           unoccupied ({@link freeInDoorstep}): a press there starts the REVERSED draw,
   *           which flows into that In. Listed last, after the sources, because the press
   *           resolves a shared doorstep to the source (UI-SPEC A10).
   *      THE OCCUPANCY RULE (UI-SPEC 1.3): a doorstep holding a machine or a belt tile
   *      ({@link doorstepOccupied}) gets no ring, because a draw that starts there is
   *      red and sends nothing, and a ring there would lie. The press lookup reads the
   *      same term, and since 74.1-11 the medium and `headTaken` terms as well, so a
   *      ring is painted exactly where a press resolves, with no exceptions: an
   *      Electrical Out and a taken Head wear no ring and their doorsteps are plain
   *      starts.
   *      WHY A MACHINE PORT HAS NO "ALREADY LINKED" TERM: the dock rule puts the linking
   *      belt's end tile ON the port's doorstep, so a linked Mechanical Out or Fault
   *      always has an occupied doorstep and the occupancy term carries the claim. A
   *      separate linked term would be a conjunct no board can isolate, which SC4
   *      deletes (pinned through occupancy on a Router whose Out_0 is catalog index 1).
   *      WHY A BELT HEAD KEEPS `headTaken`: since the host narrowing (74.1-01) a Head may
   *      dock SIDEWAYS to an In, arriving perpendicular, and leave its own doorstep free,
   *      so occupancy does not cover it (pinned by exactly that board).
   *   2. a belt end HANDLE is in flight: every port and belt end a drop of THAT end
   *      would JOIN rings, machine ports INCLUDED - ringing belt ends alone would teach
   *      the user that belt ends are a special kind of target, when the whole claim of
   *      this phase is that they stopped being special.
   *
   * ONLY REAL JOINS IN CASE 2 (plan 74.1-25, finding N4-RING and review WR-03). A target
   * rings exactly when {@link dropAccepts}, the predicate the drop ranker colours its ring
   * with, accepts it for the dragged end's CURRENT cell and outward side: role, adjacency,
   * facing and medium (`acceptsDock`) plus the host's three occupancy terms (a dragged Head
   * that already carries a Head dock accepts nowhere; a target Head that already carries
   * one does not take a Tail; since plan 74.1-33, a machine Out or Fault some belt's Tail
   * is already docked to does not take a Tail, the dragged belt's own included). THE
   * CARRIER DOES NOT MOVE DURING THE DRAG: a drop joins the belt where it lies, so a
   * ring at any end it does not touch, at a U-turn target, or on a joined Head's targets
   * promised a join the host then refused, which is what the
   * re-walk's walkers saw (a U-turn target ringed like a working join). Until this plan
   * the rings read role and medium only (`dockRoleOk`), on the argument that adjacency
   * would ring "only what the belt is already touching"; that is the point, because it is
   * only what the drop can join. A default the maintainers can overturn, set by the
   * rule plan 74.1-11 set for the press: a ring is painted exactly where the gesture
   * resolves to something the host will do.
   *
   * AN AFFORDANCE AND NEVER A GATE FOR A DROP, which is the rule 72-UI-SPEC 5.5 states
   * and manual walk step 3 depends on: in case 2 an unringed target still takes the
   * release, the release onto it still emits its one Dock, and the host answers in words.
   * If the ring's absence blocked the drop there would be nothing for the walker to walk. The
   * PRESS in case 1 is the other way round since 74.1-11 (review WR-04): it resolves
   * exactly where a ring is painted, because its target is a whole floor tile and a press
   * that recorded a dock on an unringed tile made that tile unusable as a plain start.
   *
   * A PURE PROJECTION OF THE LIVE SCENE, RECOMPUTED, NEVER CACHED, for the reason
   * `wireTargetPoints` gives above: `scene.belts` holds DENSE render handles and a full
   * keyframe rebuilds that table from zero, so a list captured at arm time would keep
   * painting rings at stale positions with no gesture and no warning.
   */
  const dockTargetPoints = (): Array<{ x: number; y: number; filled: boolean }> => {
    const scene = getScene();
    const pts: Array<{ x: number; y: number; filled: boolean }> = [];
    const centre = (port: PortView): { x: number; y: number } => ({
      x: port.cell_x * CELL + CELL / 2,
      y: port.cell_y * CELL + CELL / 2,
    });
    // A belt HEAD that already carries a Head dock is taken ({@link headTaken}, the
    // module-level term the press lookup reads too); a Tail never is.

    // 3. (phase 89, D-05, UI-SPEC 3.1) an OUTPUT-DOT drag is in flight: every belt START (Tail
    //    end) a drop there would join rings at its end tile centre, the handle drag's own ring
    //    point, by the handle drag's own predicate for that belt's Tail onto this port.
    if (outDrag) {
      const target = outDragTarget();
      if (!target) {
        return pts;
      }
      for (const belt of scene.belts.values()) {
        const port = beltEndPort(belt.tiles, 'Tail');
        if (port && dropAccepts(belt, 'Tail', target.port, MACHINE_TARGET, null, target.node)) {
          pts.push({ ...centre(port), filled: false });
        }
      }
      return pts;
    }

    if (handleDrag) {
      const drag = handleDrag;
      const carrier = scene.belts.get(drag.beltId);
      if (!carrier || carrier.tiles.length === 0) {
        return pts;
      }
      // ONE PREDICATE WITH THE DROP RANKER ({@link dropAccepts}): a ring here is a target
      // the drop's ring would paint accepting, for the dragged end where it lies now.
      for (const node of scene.nodes.values()) {
        const specs = worldNubSpecs(node);
        for (let i = 0; i < specs.length; i++) {
          if (dropAccepts(carrier, drag.end, node.ports[i], MACHINE_TARGET, null, node)) {
            pts.push({ x: specs[i].x, y: specs[i].y, filled: false });
          }
        }
      }
      for (const belt of scene.belts.values()) {
        // The belt being dragged is not a place to drop its own end.
        if (belt.id === drag.beltId) {
          continue;
        }
        for (const end of BELT_ENDS) {
          const port = beltEndPort(belt.tiles, end);
          if (port && dropAccepts(carrier, drag.end, port, beltTarget(belt.tiles, end), belt, null)) {
            pts.push({ ...centre(port), filled: false });
          }
        }
      }
      return pts;
    }

    if (beltArmed) {
      // (a) MACHINE Out and Fault ports, before belts: the press lookup's scan order, so
      // two rings at one shared doorstep list the one a press there resolves to first.
      for (const node of scene.nodes.values()) {
        for (const port of node.ports) {
          if (port.role !== PORT_ROLE.OUT && port.role !== PORT_ROLE.FAULT) {
            continue;
          }
          // A belt is always Mechanical: a ring on an Electrical Out would offer a dock
          // the host refuses as MediumMismatch. Since 74.1-11 the press reads the same
          // term, so its doorstep is a plain start, not a source.
          if (!mediumsCompatible(port.medium, MEDIUM_MECHANICAL)) {
            continue;
          }
          if (doorstepOccupied(scene, node.id, port)) {
            continue;
          }
          const filled =
            startDock !== null && startDock.node === node.id && startDock.portIndex === port.index;
          const [doorX, doorY] = doorstepCell(port);
          pts.push({ x: doorX * CELL + CELL / 2, y: doorY * CELL + CELL / 2, filled });
        }
      }
      // (b) free belt HEADS.
      for (const belt of scene.belts.values()) {
        if (headTaken(belt, scene)) {
          continue;
        }
        const port = beltEndPort(belt.tiles, 'Head');
        if (!port) {
          continue;
        }
        if (doorstepOccupied(scene, belt.id, port)) {
          continue;
        }
        // FILLED marks the ONE end a press has unambiguously grabbed, exactly as the
        // wire affordance's `filled` term does: `startDock` is what the press recorded.
        const filled =
          startDock !== null &&
          startDock.node === belt.id &&
          startDock.portIndex === port.index;
        // ON THE DOORSTEP, not the end tile (74.1, D-04): the same cell the press lookup
        // resolves and the draw seeds, so the resting ring, the press target and the
        // armed ring are one point. The handle-drag branch above keeps its end tile
        // centres; it answers a different question.
        const [doorX, doorY] = doorstepCell(port);
        pts.push({ x: doorX * CELL + CELL / 2, y: doorY * CELL + CELL / 2, filled });
      }
      // (c) free Mechanical machine INS (phase 89, D-02, UI-SPEC 1.1), last: a press on one
      // starts the REVERSED draw (`inDoorstepPressHit`), and the source lookup runs before it,
      // so at a doorstep an Out and an In share the two rings draw concentric and the press
      // resolves to the Out (A10). The ring is the Out ring's exact shape (A8). FILLED when
      // the press resolved to this In (`startIn`).
      for (const node of scene.nodes.values()) {
        for (const port of node.ports) {
          if (!freeInDoorstep(scene, node.id, port)) {
            continue;
          }
          const filled = startIn !== null && startIn.node === node.id && startIn.port.index === port.index;
          const [doorX, doorY] = doorstepCell(port);
          pts.push({ x: doorX * CELL + CELL / 2, y: doorY * CELL + CELL / 2, filled });
        }
      }
    }
    return pts;
  };

  /** Repaint the belt tool's targets from the CURRENT scene and drag state. */
  const paintDockTargets = (): void => {
    overlay.showDockTargets(dockTargetPoints());
  };

  /**
   * The client's prediction of the HOST's answer for a whole wire gesture, source
   * end and target end together (plan 66-09).
   *
   * A RANKER AND A COLOUR SOURCE, NEVER A GATE (D-07/D-08). It decides what the
   * corridor is painted and whether the release flashes; it decides NOTHING about
   * whether a `DrawWire` is sent. The release emits on any in-range target whatever
   * this returns, and the host answers in its own words.
   *
   * WHY THE SOURCE END IS IN HERE AT ALL. `acceptsWireTarget` answers host step 5 for
   * the TARGET only, which was the whole story while the press-side filter also tested
   * the medium. The 66-09 split widened that filter to role-only on purpose, so a
   * MECHANICAL Out can now start a drag - and a mechanical Out reaching a perfectly
   * good electrical In is refused `MediumMismatch` at step 5 on the SOURCE side. With
   * the target-only predicate that gesture painted the corridor build-blue for its
   * whole length, which is precisely the promise UI-SPEC 6.3 forbids: "painting it
   * build-blue would promise a wire the host cannot mint".
   *
   * ANDing a source-side constant cannot change WHICH nub the ranker picks - the term
   * is identical for every candidate in the hit list - so this is a colour change and
   * nothing more. `mediumsCompatible` is read, never re-implemented.
   */
  const wirePredictsAccept = (
    source: { medium: number },
    target: PortView,
  ): boolean =>
    mediumsCompatible(source.medium, MEDIUM_ELECTRICAL) && acceptsWireTarget(target);

  /**
   * Endpoint-handle hit-test for the SELECTED belt: a press inside exactly one END
   * TILE of a multi-tile belt grabs that end (plan 74.1-15, gap N4b); otherwise the
   * nearest handle center
   * (from ports.beltHandlePoints — a docked end at the resolved nub, an
   * undocked end at the end tile center) within nubHitRadiusWorld of the
   * screen point, or null. Handle positions are recomputed lazily HERE at
   * hit-test time (there is no per-frame hook in this layer); the DRAWN handle
   * positions refresh on selection changes, after each dock release/emit, AND
   * when the host re-emits the selected belt (refreshSelection, WR-02) — so
   * the drawn circles always track the same points this hit-test resolves.
   */
  const hitHandle = (
    sx: number,
    sy: number,
  ): { end: BeltEnd; pt: { x: number; y: number } } | null => {
    if (selection?.kind !== 'belt') {
      return null;
    }
    const scene = getScene();
    const belt = scene.belts.get(selection.id);
    if (!belt || belt.tiles.length === 0) {
      return null;
    }
    const w = cam.screenToWorld(sx, sy);
    const pts = beltHandlePoints(scene.nodes, scene.belts, belt);
    // THE END TILE GRABS ITS END (plan 74.1-15, gap N4b). A joined end's dot is drawn
    // at the SEAM, 16 world px from its tile centre and outside the 12 px radius at
    // scale 1, so a press on the end tile used to grab nothing, silently (user report: "on all
    // belts I see only ends to drag"). A press inside EXACTLY ONE end tile of a
    // multi-tile belt is a grab of that end. Tile bounds are CLOSED, so a press on the
    // edge two end tiles share (a two-tile belt) is inside both and falls through to the
    // radius rule below, as does every press outside both tiles and every press on a
    // single-tile belt (whose two ends are one tile). The drawn dot does not move.
    // The containment term is `inTile`, shared with the drop (plan 74.1-25).
    if (belt.tiles.length >= 2) {
      const inHead = inTile(belt.tiles, 'Head', w);
      const inTail = inTile(belt.tiles, 'Tail', w);
      if (inHead !== inTail) {
        return inHead ? { end: 'Head', pt: pts.head } : { end: 'Tail', pt: pts.tail };
      }
    }
    const r = nubHitRadiusWorld(camScale());
    const d2 = (p: { x: number; y: number }): number =>
      (p.x - w.x) * (p.x - w.x) + (p.y - w.y) * (p.y - w.y);
    const dh = d2(pts.head);
    const dt = d2(pts.tail);
    if (Math.min(dh, dt) > r * r) {
      return null;
    }
    return dh <= dt
      ? { end: 'Head', pt: pts.head }
      : { end: 'Tail', pt: pts.tail };
  };

  // ---- handle-hover affordance (UI-SPEC section 3 pixel lock) --------------
  // Cursor within a selected belt's endpoint-handle hit target → r=8 hoverRing
  // ring + cursor 'pointer'; both cleared on leave. Joins the clearSelection()
  // / destroy() cleanup set like every other ephemeral affordance.
  let handleHover = false;
  const clearHandleHover = (): void => {
    if (!handleHover) {
      return;
    }
    handleHover = false;
    overlay.clearHandleRing();
    if (canvas.style.cursor === 'pointer') {
      canvas.style.cursor = '';
    }
  };

  // ---- idle nub hover (D-10, UI-SPEC section 4) -----------------------------
  // Cursor within the zoom-compensated hit radius of ANY port nub shows the
  // PASSIVE nub ring with PRIORITY over the body hover ring (nub hits beat
  // body hits — locked; the footprint cell scan stays the body fallback). The
  // flag tracks only the idle-hover instance of the ring so it never clears a
  // ring the dock drag or the port-to-port draw owns.
  let nubHover = false;
  const clearNubHover = (): void => {
    if (!nubHover) {
      return;
    }
    nubHover = false;
    overlay.clearNubRing();
  };
  // THE GRAB CUE ON AN OUTPUT DOT (phase 89, UI-SPEC A13): the idle nub hover on a Mechanical
  // Out or Fault dot also sets cursor `pointer`, the shipped grab-hover cue, because a drag
  // starts there (the output-dot drag). Its own flag, so the reset never takes down a `pointer`
  // another hover set: those branches set the cursor before they clear the nub hover.
  let nubCursor = false;
  const clearNubCursor = (): void => {
    if (!nubCursor) {
      return;
    }
    nubCursor = false;
    if (canvas.style.cursor === 'pointer') {
      canvas.style.cursor = '';
    }
  };

  /**
   * (Re-)show the selected belt's endpoint handles at their CURRENT
   * beltHandlePoints. Called on belt selection, after each dock release
   * (post-emit snap-back/refresh), and when the host re-emits the selected
   * belt (refreshSelection, WR-02) — handle positions refresh on those events
   * rather than per-frame (see {@link hitHandle}).
   */
  const reshowBeltHandles = (): void => {
    if (selection?.kind !== 'belt') {
      return;
    }
    const scene = getScene();
    const belt = scene.belts.get(selection.id);
    if (!belt) {
      return;
    }
    const pts = beltHandlePoints(scene.nodes, scene.belts, belt);
    overlay.showBeltHandles(pts.head, pts.tail);
  };

  // ---- stranded-dock rings -> reconnect press (CONNECT-02) ------------------
  //
  // THE ONE GENUINELY NEW SHAPE IN THIS FEATURE, AND IT IS PLUMBING. The
  // detector (`strandedDocks.ts`), the ring paint (`overlay.showAlertRings`) and
  // the two resolved world points (App.tsx's packet handler) all shipped in
  // Phase 21/26. What did not exist is a path from the stranded EVENT to this
  // layer: App flattened both points into one bare `pts` array for the overlay,
  // losing which point is a port nub and which is a belt end, and the gesture
  // layer could not see them at all (67-RESEARCH Finding 9). `setStrandedRings`
  // is that path; everything below it primes state the shipped belt-handle drag
  // machinery already reads.
  //
  // The set has the SAME lifetime as the paint and is re-driven by App on every
  // packet, so a handle retained across a `full` keyframe remint cannot linger
  // (T-67-05-01): the keyframe's own structural clear hands over an empty array.
  let strandedRings: readonly StrandedRing[] = [];

  /**
   * The stranded-ring grab radius, in world px.
   *
   * BOUND, NOT RESTATED. `wireNubHitRadiusWorld` is the project's own 44px
   * minimum-target floor (style bible 6d) halved into a world radius and
   * zoom-compensated; a stranded ring is the same kind of circular grab target
   * as a wire nub, so it gets the same number from the same function. Minting a
   * second formula for one shape is the `ROUTER_PRESET_PORT_LEGS`
   * second-source-of-truth failure Phase 65 found. `hitHandle`'s own
   * `nubHitRadiusWorld` is deliberately NOT widened here - 67-UI-SPEC and
   * decision D4 fence that out of this phase.
   */
  const strandedRingHitRadiusWorld = wireNubHitRadiusWorld;

  /**
   * The stranded ring whose belt-end point is NEAREST the screen point and
   * inside the grab radius, or null.
   *
   * NEAREST-FIRST, not first-in-array. One Rotate can strand MORE THAN ONE belt
   * at once (the zero-one-many case), App paints one ring pair per stranded
   * belt, and every other multi-target hit test in this file resolves
   * nearest-first (`nubsInRadius` sorts by distance; `hitHandle` compares the
   * two endpoint distances). TIE-BREAK, named so it is deterministic rather than
   * incidental: the comparison is STRICT (`<`), scanning in array order, so two
   * rings exactly equidistant from the pointer resolve to the EARLIER record -
   * the same stable "equal distances keep enumeration order" rule `nubsInRadius`
   * and `hitHandle` (`dh <= dt` -> Head) both use. App's array order is the
   * detector's event order, which is itself deterministic.
   *
   * Gated on `overlay.alertRingsActive()` so the PRESSABLE set is exactly the
   * PAINTED set. Without that gate an EXPIRED ring (the ring TTL elapsing inside
   * `overlay.tick`) would stay invisibly grabbable and an ordinary click near a
   * belt end would silently start a dock drag. The TTL CONSTANT ITSELF IS NEVER
   * NAMED IN THIS FILE and must not be - it is `overlay.ts`'s, and a copy here
   * would be a second source of truth for one lifetime; this reads the same
   * `alertBornMs` state the paint is driven from, which is why a grep for the
   * constant's name in this file returns nothing and that is asserted. A drag
   * ALREADY IN FLIGHT never re-reads this - see the press arm.
   */
  const hitStrandedRing = (sx: number, sy: number): StrandedRing | null => {
    if (strandedRings.length === 0 || !overlay.alertRingsActive()) {
      return null;
    }
    const w = cam.screenToWorld(sx, sy);
    const r = strandedRingHitRadiusWorld(camScale());
    const rr = r * r;
    let best: StrandedRing | null = null;
    let bestD2 = Infinity;
    for (const ring of strandedRings) {
      const dx = ring.pt.x - w.x;
      const dy = ring.pt.y - w.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= rr && d2 < bestD2) {
        bestD2 = d2;
        best = ring;
      }
    }
    return best;
  };

  const setStrandedRings = (rings: readonly StrandedRing[]): void => {
    strandedRings = rings;
  };

  // ---- stranded-ring hover cue (67-UI-SPEC 4.2, Hover row) -----------------
  // The ring must say it is GRABBABLE before it is grabbed. It reuses
  // `showHandleRing` - the SAME r=8 stroke-1.5px pal.hover geometry the selected
  // belt's endpoint handle already draws - and therefore the SAME Graphics child
  // (`handleRing`), which is what keeps the UI-SPEC's "no new Graphics child, no
  // z-order slot moves" gate true. `handleRing` sits ABOVE `alertRings` in the
  // z-order chain, so the hover ring layers OVER the still-pulsing fault ring
  // exactly as 4.2 specifies, for free.
  //
  // The child is not CLAIMED by the endpoint handle in any way that conflicts:
  // the two hovers are mutually exclusive by construction (the move handler
  // resolves exactly one branch and clears the others before returning), and
  // each owns its own flag so neither can clear a ring the other is showing.
  let strandedHover = false;
  const clearStrandedHover = (): void => {
    if (!strandedHover) {
      return;
    }
    strandedHover = false;
    overlay.clearHandleRing();
    if (canvas.style.cursor === 'pointer') {
      canvas.style.cursor = '';
    }
  };

  // ---- endpoint-handle drag -> Dock (CTRL-01, D-09 drag half) ---------------
  // Grabbing a selected belt's endpoint handle starts a dock drag: the handle
  // follows the cursor, the chosen nub under the cursor gets a ring (build-
  // coloured when the host-mirror predicate accepts, passive hoverRing when not),
  // and release on ANY reachable nub emits exactly ONE Dock. Since Phase 64 the
  // ring colour is a PREDICTION and the drop candidate is an ADDRESS: they are
  // no longer the same decision. A non-accepting ring means "this will probably
  // be refused, and the host will say why" — not "this will be swallowed".
  // `fromRing` is the drag's PROVENANCE, and it exists for exactly one reason:
  // the two callers of this one drag disagree about what a release-on-nothing
  // MEANS. From a stranded ring it is a near-miss on a recovery the user was
  // attempting (flash the WHERE). From a selected belt's endpoint handle it is
  // the DOCUMENTED CANCEL - `21-UI-SPEC.md:137` and `:206`, "No command; handle
  // snaps back" - and it is the ONLY abort that gesture has, because Escape
  // (`gestures.ts:2686`) does not touch `handleDrag`. Flashing a rejection at a
  // user who deliberately cancelled would be the app arguing with an intent it
  // was told. Downstream stages stay unaware of provenance; only the
  // release-on-nothing branch reads it.
  let handleDrag: { beltId: number; end: BeltEnd; fromRing: boolean } | null = null;
  /**
   * The addressed drop target: the first ACCEPTING candidate, or the first candidate
   * outright when none accept, where the candidates are every other belt's end whose END
   * TILE holds the pointer (nearest first) ahead of every nub in the hit radius (nearest
   * first). Set whenever any candidate is reachable (D-07); the acceptance predicate ranks
   * it, it does not gate it.
   */
  let dropCandidate: { node: number; port: number } | null = null;

  const updateDropCandidate = (w: { x: number; y: number }): void => {
    dropCandidate = null;
    if (!handleDrag) {
      return;
    }
    const drag = handleDrag;
    const scene = getScene();
    const belt = scene.belts.get(drag.beltId);
    if (!belt || belt.tiles.length === 0) {
      overlay.clearNubRing();
      return;
    }
    // THE DROP READS THE PRESS'S RULE (plan 74.1-25, gap N4-DROP). A press anywhere on a
    // belt's end tile picks that end up (`hitHandle`, plan 74.1-15), so a hand expects to
    // let go anywhere on the target's end tile too. The re-walk found it could not: the
    // drop read only the disc below, 12 world px around the target end's centre, so a drop
    // 13 screen px out on a 35.5 px tile snapped back with nothing sent and nothing said.
    //
    // TWO SOURCES, ONE LIST:
    //   1. every OTHER belt's end whose end TILE holds the pointer, through `inTile`, the
    //      one containment term the press reads (closed bounds);
    //   2. every nub inside the zoom-compensated hit radius, WITH BELT ENDS (LINK-02), at
    //      the DEFAULT radius and never the wire one (T-74-22's mitigation), minus anything
    //      source 1 already holds.
    // Source 1 is listed first and the list is then sorted nearest first, stably, so an
    // end-tile hit stays ahead of a radius hit at an equal distance. The ranking below
    // takes the first ACCEPTING candidate, else the first. So on the edge two end tiles
    // share (inside both closed tiles, both centres equally far) the accepting end wins,
    // and a pointer just inside one tile addresses that tile's end, the nearer one.
    //
    // NEAREST ACROSS BOTH SOURCES, NOT TILE-FIRST, and the board that decided it is the
    // CONNECT-02 stranded-ring one: a machine Out nub is drawn pushed past the machine's
    // edge, INSIDE its doorstep tile, and a belt docked there has its end tile on that
    // doorstep. A tile-first list addressed that belt's end when the user let go ON the
    // nub. For belt ends the order changes nothing: belt end points are tile centres on
    // one grid, so the end tile holding the pointer is always the nearest belt end, and
    // the tile adds only the reach beyond the disc.
    //
    // MACHINE PORTS KEEP THE RADIUS. A machine port has no end tile of its own: its nub is
    // a point on the machine's edge, a body cell can carry several ports on different
    // sides, and a whole-cell target there would address a port when the user lets go on
    // the machine's body. The disc keeps a machine drop on the nub the user sees, as it
    // has since Phase 64; only belt ends, whose end tile IS the thing the user grabs and
    // aims at, gain the tile.
    //
    // No candidate at all is still nothing: an empty-floor release addresses no port and
    // emits nothing, exactly as before (the documented cancel).
    //
    // THE DRAGGED BELT'S OWN ENDS ARE NOT DROP TARGETS, in either source, and this
    // exclusion is a regression guard rather than a gate on host state. The dragged end's
    // own nub sits at its unmoved tile centre, so without it a press-and-release-without-
    // moving - the DOCUMENTED CANCEL, `21-UI-SPEC.md:137` - would address the belt's own
    // end and emit a self-`Dock` the host refuses in words. Arguing with a user who
    // deliberately backed out is the exact defect the `fromRing` flash split was narrowed
    // to avoid.
    const tileHits: NubHit[] = [];
    for (const other of scene.belts.values()) {
      if (other.id === drag.beltId || other.tiles.length < 2) {
        continue;
      }
      for (const end of BELT_ENDS) {
        if (!inTile(other.tiles, end, w)) {
          continue;
        }
        const port = beltEndPort(other.tiles, end);
        if (!port) {
          continue;
        }
        const x = port.cell_x * CELL + CELL / 2;
        const y = port.cell_y * CELL + CELL / 2;
        const d2 = (x - w.x) * (x - w.x) + (y - w.y) * (y - w.y);
        tileHits.push({ node: null, handle: other.id, port, x, y, d2 });
      }
    }
    const inTileHit = (h: NubHit): boolean =>
      h.node === null &&
      tileHits.some((t) => t.handle === h.handle && t.port.index === h.port.index);
    // Stable (ES2019), so equal distances keep this order: end tiles first, then the
    // radius scan's own order (`nubsInRadius`'s rule).
    const hits = [
      ...tileHits,
      ...nubsInRadius(w, nubHitRadiusWorld(camScale()), 'ports+belt-ends').filter(
        (h) => (h.node !== null || h.handle !== drag.beltId) && !inTileHit(h),
      ),
    ].sort((a, b) => a.d2 - b.d2);
    if (hits.length === 0) {
      overlay.clearNubRing();
      return;
    }
    // RANKER, not gate (Phase 64, D-07). `acceptsDock` is the host mirror
    // (command.rs validate arm / dock_still_reaches + the PORT-08 medium gate)
    // and it is used here as the RANKING KEY over the hit-radius set — never as
    // an emission gate.
    //
    // The reading taken of CONTEXT's "use `dockCandidates` over the hit-radius
    // set", recorded so the next reader does not re-litigate it: `dockCandidates`
    // itself is NOT called here and must not be. It is a thin loop over
    // `acceptsDock` across every port of every node with no notion of the
    // pointer, the camera scale or the hit radius, so calling it on this path
    // would address a port anywhere on the board that happens to satisfy the
    // geometry — worse than the bug being fixed. The acceptance predicate it
    // wraps IS the candidate logic, and that is what is applied here.
    //
    // Preferring the nearest ACCEPTING hit is the drift-A fix: an Electrical nub
    // two pixels closer than a legal Mechanical one used to end the search and
    // make the legal farther port unreachable. When NONE accept, the nearest is
    // addressed anyway and the host refuses it with a typed reason the user can
    // read. The prediction decides WHAT to send; it no longer decides WHETHER.
    //
    // THE TARGET'S SHAPE IS PASSED, NEVER ASSUMED (plan 74.1-15, gap N4). A machine port
    // is judged by the doorstep rule; a belt end by the one-step rule with its INNER tile
    // read off that belt's own tiles for that end, exactly as the host's Dock arm splits.
    // Without it a belt end would be judged by the machine rule and the ring would paint
    // the refused direction of the N4 board passive while the host accepts it.
    const targetOf = (h: NubHit): DockTargetShape => {
      if (h.node !== null) {
        return MACHINE_TARGET;
      }
      const other = scene.belts.get(h.handle);
      const end: BeltEnd = h.port.index === BELT_PORT_HEAD ? 'Head' : 'Tail';
      return other ? beltTarget(other.tiles, end) : { kind: 'belt', inner: null };
    };
    // THE OCCUPANCY TERMS (plan 74.1-25, review WR-03) ride in through `dropAccepts`, the
    // one predicate the handle-drag rings read too: a joined Head grabbed from its tile
    // paints passive everywhere, because the host refuses its every drop (`BeltEndTaken`
    // since plan 74.1-32, `PortOccupied` before it); and since plan 74.1-33 (review round 4
    // WR-02) a docked Tail paints passive over the Out it is docked to. The hit's NodeView
    // rides in for that term, null for a belt end.
    const accepting = hits.find((h) =>
      dropAccepts(
        belt,
        drag.end,
        h.port,
        targetOf(h),
        h.node === null ? (scene.belts.get(h.handle) ?? null) : null,
        h.node,
      ),
    );
    const best = accepting ?? hits[0];
    overlay.showNubRing({ x: best.x, y: best.y }, accepting !== undefined);
    dropCandidate = { node: best.handle, port: best.port.index };
  };

  // ---- the output-dot drag and the unselected end-tile grab (phase 89, D-05, BELT-04) ----
  //
  // WINDOWS 113 items ii and iii. Until phase 89 every dock gesture belonged to the BELT: the
  // handle drag above needs the belt selected first, and a new draw needs the Belt tool. A drag
  // from a machine's output dot onto a belt end was a select of the machine and nothing else,
  // and a press on an unselected belt's end tile was a select of the belt. D-05
  // (2026-10-22) gives both a drag, with no tool armed and no selection needed.
  //
  // A PRESS IS A CLICK UNTIL IT LEAVES (UI-SPEC A11). A press within the hit radius of a
  // Mechanical Out or Fault dot records `outPress` beside the same `down` a body press records,
  // so a release inside the radius is the shipped select. Only once the pointer leaves that
  // radius does the drag start (`outDrag`), and then `down` is dropped. The end tile is the
  // same rule with the tile as the bound (`endPress`), into the shipped `handleDrag`.
  //
  // THE DROP IS THE HANDLE DRAG'S, SEEN FROM THE OTHER END. The candidates are belt Tail ends
  // (a belt's start: the only end an Out or Fault takes), found the way `updateDropCandidate`
  // finds belt ends (`inTile` on the end tile first, then the radius scan), ranked by the same
  // `dropAccepts` call the handle drag makes for that belt's Tail onto this port. A release on
  // one sends ONE `Dock { belt, Tail, node, port }`, byte for byte the frame a selected belt's
  // Tail handle dropped on this port sends, with the same claim. A release on nothing flashes
  // the release cell (the ring drag's empty release) and sends nothing. The selection is never
  // touched: this gesture names its belt by where it lands, not by what is selected.
  //
  // ONLY MECHANICAL OUT AND FAULT DOTS (UI-SPEC A12): a belt is Mechanical, so an Electrical
  // output could never take one, and its dot stays a body press. An In never starts it.
  let outPress: { node: number; port: number; pt: { x: number; y: number }; at: { x: number; y: number } } | null = null;
  /**
   * The travel from the PRESS POINT, in screen px, an output-dot press needs before it can become
   * a drag (review WR-B-04, the usual drag slop). Leaving the dot's reach alone is not enough: a
   * press near the edge of the reach left it after a 1 or 2 px wobble, so a click read as a drag
   * released on nothing (a red flash, no selection).
   */
  const OUT_DRAG_SLOP_PX = 4;
  let outDrag: { node: number; port: number } | null = null;
  /** The belt whose Tail the output-dot drag would dock, or null (the drop candidate). */
  let outDropBelt: number | null = null;
  /** A press inside exactly one end tile of an unselected multi-tile belt, not yet a drag. */
  let endPress: { beltId: number; end: BeltEnd } | null = null;

  /**
   * The output dot a press or a hover at screen (sx, sy) is on: the NEAREST nub in the hit
   * radius (the idle hover's own `nearestNub`, so the cue and the press agree), when it is a
   * machine's Mechanical Out or Fault. Null otherwise, including when the nearest nub is an In
   * or an Electrical port beside a Mechanical output, and when the pointer is on ANOTHER
   * machine's body (review WR-B-01): the reach grows to 1.5 cells at camera scale 0.25, and a
   * press on a neighbour standing beside the output must select that neighbour, not the dot's
   * owner, as it did before phase 89.
   */
  const outDotAt = (sx: number, sy: number): { node: number; port: PortView; x: number; y: number } | null => {
    const hit = nearestNub(cam.screenToWorld(sx, sy));
    if (!hit || hit.node === null) {
      return null;
    }
    const cell = cam.screenToCell(sx, sy);
    const body = nodeAtCell(getScene(), cell.cx, cell.cy);
    if (body && body.id !== hit.handle) {
      return null;
    }
    const { role, medium } = hit.port;
    if (role !== PORT_ROLE.OUT && role !== PORT_ROLE.FAULT) {
      return null;
    }
    if (!mediumsCompatible(medium, MEDIUM_MECHANICAL)) {
      return null;
    }
    return { node: hit.handle, port: hit.port, x: hit.x, y: hit.y };
  };

  /** The live machine and port the output-dot drag carries, or null when a remint took it. */
  const outDragTarget = (): { node: NodeView; port: PortView } | null => {
    if (!outDrag) {
      return null;
    }
    const node = getScene().nodes.get(outDrag.node);
    const index = outDrag.port;
    const port = node?.ports.find((p) => p.index === index);
    return node && port ? { node, port } : null;
  };

  /** Re-rank the output-dot drag's drop candidate at world point `w` and paint its ring. */
  const updateOutDropCandidate = (w: { x: number; y: number }): void => {
    outDropBelt = null;
    const target = outDragTarget();
    if (!target) {
      overlay.clearNubRing();
      return;
    }
    const scene = getScene();
    const cands: Array<{ belt: BeltView; x: number; y: number; d2: number }> = [];
    for (const belt of scene.belts.values()) {
      if (belt.tiles.length < 2 || !inTile(belt.tiles, 'Tail', w)) {
        continue;
      }
      const port = beltEndPort(belt.tiles, 'Tail');
      if (!port) {
        continue;
      }
      const x = port.cell_x * CELL + CELL / 2;
      const y = port.cell_y * CELL + CELL / 2;
      cands.push({ belt, x, y, d2: (x - w.x) * (x - w.x) + (y - w.y) * (y - w.y) });
    }
    for (const h of nubsInRadius(w, nubHitRadiusWorld(camScale()), 'ports+belt-ends')) {
      if (h.node !== null || h.port.index !== BELT_PORT_TAIL || cands.some((c) => c.belt.id === h.handle)) {
        continue;
      }
      const belt = scene.belts.get(h.handle);
      if (belt) {
        cands.push({ belt, x: h.x, y: h.y, d2: h.d2 });
      }
    }
    // Stable, so an end-tile hit stays ahead of a radius hit at an equal distance.
    cands.sort((a, b) => a.d2 - b.d2);
    if (cands.length === 0) {
      overlay.clearNubRing();
      return;
    }
    const accepting = cands.find((c) => dropAccepts(c.belt, 'Tail', target.port, MACHINE_TARGET, null, target.node));
    const best = accepting ?? cands[0];
    overlay.showNubRing({ x: best.x, y: best.y }, accepting !== undefined);
    outDropBelt = best.belt.id;
  };

  /** End the output-dot press or drag with nothing sent: every mark it painted goes with it. */
  const endOutDrag = (): void => {
    const dragging = outDrag !== null;
    outPress = null;
    outDrag = null;
    outDropBelt = null;
    if (dragging) {
      cam.setPanEnabled(true);
      if (canvas.style.cursor === 'grabbing') {
        canvas.style.cursor = '';
      }
      overlay.clearDraggedHandle();
      overlay.clearNubRing();
      overlay.clearDockTargets();
    }
  };

  // ---- ONE POINTER OWNS A GESTURE, AND AN INTERRUPTION ENDS IT (phase 89, plan 89-07, D-11) ----
  //
  // The draw used to be one global any pointer fed: a second finger or a pen reseeded the path,
  // and its lift committed a belt nobody drew (WINDOWS 253). A gesture is now OWNED by the pointer
  // that pressed it: `gesturePointer` is that press's `pointerId`, and while any gesture is in
  // flight every event of any OTHER pointer is a stranger's and is ignored, its down, its moves, its
  // up and its cancel. The id IS the identity of the draw; there is no second model of "the current
  // draw" beside it. An event that carries no `pointerId` (the vitest rig's plain objects) is the
  // owner's, so every rig case reads as before.
  //
  // A belt or wire draw also asks the canvas for POINTER CAPTURE at its press, inside a `try`
  // (research Pitfall 6: a synthetic event's id is no active pointer and the call throws). Capture
  // is a help, keeping the moves and the release on the canvas when the hand leaves it; the stored
  // id is the rule.
  //
  // AN INTERRUPTION NEVER LAYS A BELT (WINDOWS 245, T-89-18). A `pointercancel` (an OS gesture took
  // the pointer), a `lostpointercapture` of the owner, a window `blur`, or a move of the owner whose
  // `buttons` no longer carries the left bit (the webview lost the release) ends the gesture with
  // nothing sent: the belt path and its marks go, the Belt tool stays armed, and the later
  // `pointerup`, if any, finds no path. No flash and no sentence (UI-SPEC A15): the vanished preview
  // is the feedback. A move with no `buttons` field (the rig) is never read as a lost release.
  let gesturePointer: number | null = null;

  /** Whether any pointer gesture is in flight: a belt path, a wire source, or a no-tool press or drag. */
  const gestureInFlight = (): boolean =>
    drawnCells !== null ||
    wireSource !== null ||
    handleDrag !== null ||
    outPress !== null ||
    outDrag !== null ||
    endPress !== null ||
    rotatePress !== null ||
    down !== null;

  /** An event of a pointer other than the one that owns the gesture in flight. */
  const isStranger = (e: PointerEvent): boolean =>
    gesturePointer !== null &&
    typeof e.pointerId === 'number' &&
    e.pointerId !== gesturePointer &&
    gestureInFlight();

  /** Whether the owner's press took pointer capture (a belt or wire draw whose capture call worked). */
  let ownerCaptured = false;

  /** Record the pressing pointer as the owner, and for a draw ask the canvas to capture it. */
  const ownPointer = (e: PointerEvent, capture: boolean): void => {
    gesturePointer = typeof e.pointerId === 'number' ? e.pointerId : null;
    ownerCaptured = false;
    if (capture && gesturePointer !== null) {
      try {
        canvas.setPointerCapture(gesturePointer);
        ownerCaptured = true;
      } catch {
        // Pitfall 6: no active pointer by that id (a synthetic event). The stored id still owns.
      }
    }
  };

  /**
   * THE OWNER IS GONE (review WR-B-03): a left press that proves the gesture in flight lost its
   * end. Either the owner pressed again (a pointer cannot be pressed twice, so its release was
   * lost: WebKitGTK outside the window), or another pointer pressed after the owner lost the
   * capture its draw took (a touch whose `pointerup` and `pointercancel` both went missing). Then
   * the old gesture ends with nothing sent and the press is a fresh one. Without this the next
   * left press of a mouse was dropped and the old path walked on from its stale anchor, and every
   * later touch was a stranger. A second finger beside a LIVE owner, or any press while the owner
   * holds its capture, is still a stranger's (D-11). Only a left press counts: a chorded middle or
   * right button is a move, and a device that sends it as a down must not end the draw.
   */
  const ownerLost = (e: PointerEvent): boolean => {
    if (gesturePointer === null || typeof e.pointerId !== 'number' || e.button !== 0 || !gestureInFlight()) {
      return false;
    }
    if (e.pointerId === gesturePointer) {
      return true;
    }
    return ownerCaptured && typeof canvas.hasPointerCapture === 'function' && !canvas.hasPointerCapture(gesturePointer);
  };

  /** The owner's move says the left button is up: a release the page never received. */
  const leftReleased = (e: PointerEvent): boolean => typeof e.buttons === 'number' && (e.buttons & 1) === 0;
  /** The owner's move carries the right button too: a right press chorded into a left drag. */
  const rightChorded = (e: PointerEvent): boolean => typeof e.buttons === 'number' && (e.buttons & 2) !== 0;
  /** The owner's move carries the middle button too: a middle press chorded into a left drag. */
  const middleChorded = (e: PointerEvent): boolean => typeof e.buttons === 'number' && (e.buttons & 4) !== 0;

  /**
   * THE PATH-ONLY TEARDOWN (D-11): the belt path ends with nothing sent and the Belt tool stays
   * armed. Cells, walk anchor, start dock, feed, reversed start and pointer go; the preview and the
   * armed ring clear; the resting rings repaint without the grabbed disc. Shared by Escape, the
   * right button, a cancel, a lost capture, a blur and a lost release.
   */
  const dropBeltPath = (): void => {
    drawnCells = null;
    drawnFrom = null;
    startDock = null;
    startFeed = null;
    startIn = null;
    beltPointer = null;
    overlay.clearBeltPreview();
    overlay.clearNubRing();
    if (beltArmed) {
      paintDockTargets();
    }
  };

  /** The wire draw's twin (D-11, "where it shares the code"): the source goes, the Wire tool stays. */
  const cancelWireSource = (): void => {
    wireSource = null;
    overlay.clearRoute();
    overlay.clearNubRing();
    if (wireArmed) {
      paintWireTargets();
    }
  };

  /**
   * End every no-tool press or drag with nothing sent (plan 89-07, the 89-06 carry-over): the
   * output-dot press and drag, an unselected belt's end-tile press, a belt-handle or ring drag, a
   * rotate-handle press and a select candidate. The selection is not touched; a selected belt's
   * handles snap back. Returns whether anything was in flight; with nothing in flight it changes
   * nothing at all.
   */
  const cancelIdleGesture = (): boolean => {
    const any =
      handleDrag !== null ||
      outDrag !== null ||
      outPress !== null ||
      endPress !== null ||
      rotatePress !== null ||
      down !== null;
    if (!any) {
      return false;
    }
    if (handleDrag !== null) {
      handleDrag = null;
      dropCandidate = null;
      if (canvas.style.cursor === 'grabbing') {
        canvas.style.cursor = '';
      }
      overlay.clearDraggedHandle();
      overlay.clearNubRing();
      overlay.clearDockTargets();
      reshowBeltHandles();
    }
    endOutDrag();
    endPress = null;
    rotatePress = null;
    down = null;
    cam.setPanEnabled(!beltArmed && !wireArmed && placementKind === null);
    return true;
  };

  /** A cancel, a lost capture, a blur or a lost release: every gesture in flight ends, nothing sent. */
  const interruptGesture = (): void => {
    if (drawnCells !== null) {
      dropBeltPath();
    }
    if (wireSource !== null) {
      cancelWireSource();
    }
    cancelIdleGesture();
  };

  const onPointerCancel = (e: PointerEvent): void => {
    if (isStranger(e)) {
      return;
    }
    interruptGesture();
  };

  // Only the owner's capture: the camera captures and releases the same mouse for a middle pan
  // between draws, and a release with no gesture in flight changes nothing.
  const onLostCapture = (e: PointerEvent): void => {
    if (gesturePointer === null || e.pointerId !== gesturePointer) {
      return;
    }
    interruptGesture();
  };

  const onBlur = (): void => {
    interruptGesture();
  };

  // FAIL-01 (D-12): the stop ends everything the board had in hand, nothing sent (see
  // `GestureController.standDown`). The same teardowns Escape runs, all of them at once.
  const standDown = (): void => {
    interruptGesture();
    if (beltArmed) disarmBelt();
    if (wireArmed) disarmWire();
    if (placementKind !== null) disarmPlacement();
    if (selection !== null) {
      selection = null;
      overlay.clearSelection();
      overlay.clearBeltHandles();
      clearHandleHover();
      deps.onSelect?.(null);
      deps.onSelectBelt?.(null);
    }
  };

  const onCanvasDown = (e: PointerEvent): void => {
    if (ownerLost(e)) {
      interruptGesture();
      gesturePointer = null;
    }
    if (isStranger(e)) {
      return;
    }
    // FAIL-01 (D-12): on a stopped simulation a press selects nothing and starts nothing. The
    // camera's own listeners still take the middle-button pan and the wheel.
    if (simStopped()) {
      return;
    }
    if (beltArmed) {
      // THE MIDDLE BUTTON PANS AND NEVER CANCELS (D-11, WINDOWS 244, NAV-04): the camera pans on
      // it whatever is armed (`camera.ts`), so the tool and any path stay.
      if (e.button === 1) {
        return;
      }
      // ONLY THE RIGHT BUTTON CANCELS, and the path before the tool: with a path in progress it
      // ends the path and keeps the Belt tool; with none it puts the tool away (IX-08, so the
      // context menu that follows can never open over an armed tool).
      if (e.button !== 0) {
        if (drawnCells !== null) {
          dropBeltPath();
        } else {
          disarmBelt();
        }
        return;
      }
      // A second down while a draw is in progress never reseeds it.
      if (drawnCells !== null) {
        return;
      }
      ownPointer(e, true);
      // A new draw leaves every held picture alone (plan 74.1-30): those belts are
      // committed and live on the overlay's held surface, so this gesture's drag preview
      // and their pictures both show, and each picture ends on its own belt's echo.
      const p = toLocal(e);
      startDock = null;
      startFeed = null;
      startIn = null;
      beltPointer = null;
      // Port-to-port draw (D-12), PRESSED ON THE DOORSTEP since phase 74.1. The press
      // is resolved BY CELL: `doorstepPressHit` answers the Out or Fault port (a machine
      // port or a belt's free Head, which is `Role::Out`) whose DOORSTEP is the pressed
      // cell, the floor cell that port feeds. A hit records the source dock (belt TAIL
      // end, see the keyspace note at startDock) and seeds the draw on that same
      // doorstep, so the press cell IS the seed cell at every zoom, by construction: the
      // lookup reads `cam.screenToCell`, the accessor the plain seed below and the walk
      // read. A press on a free Mechanical In's doorstep starts the REVERSED draw below
      // (phase 89, D-02). A press anywhere else, including a belt's own last tile or a
      // machine's own cell, falls through to the plain cell seed with no dock.
      // The armed ring marks the committed source, concentric with its resting ring.
      //
      // Before 74.1 this was the nearest nub inside a hit disc (`nubsInRadius` over
      // ports and belt ends), anchored on the belt's own end tile and the machine's
      // edge, so the press landed a cell BEHIND the seed and a drag that turned at once
      // drew a stub or nothing. That scan now has one reader, the handle-drag drop.
      const hit = doorstepPressHit(cam.screenToCell(p.x, p.y));
      if (hit) {
        // Every hit here is a Mechanical source: since 74.1-11 an Electrical doorstep is
        // no press target (`doorstepPressHit` reads the ring set's medium term), so a
        // press there is the plain seed below. The medium check this branch used to
        // carry (the Phase 64 seventh suppression site) could only be true, and is gone.
        drawnCells = [doorstepCell(hit.port)];
        // The walk's anchor starts at the PRESS point (74-14), and since 74.1 the press
        // point is INSIDE the seed cell, so the first walked cell is the seed itself.
        drawnFrom = p;
        startDock = { node: hit.handle, portIndex: hit.port.index };
        // The Tail seam's feed (74.1-08): the flow out of the pressed port. Every hit is
        // a dock the host accepts on medium, so every hit feeds a corner.
        startFeed = hit.port.side;
        beltPointer = cam.screenToWorld(p.x, p.y);
        // `hit.x, hit.y` is the doorstep centre, the same point the resting ring for
        // this port is painted on, so the armed ring lands concentric with it. Always
        // ACCEPTING: the hit passed the ring set's own terms.
        overlay.showNubRing({ x: hit.x, y: hit.y }, true);
        // REPAINT WITH THE GRABBED END FILLED, the same move `paintWireTargets` makes
        // after a wire press: the user sees WHICH end the press resolved to before they
        // release, and the resting set survives the press rather than blinking out.
        paintDockTargets();
        refreshBeltPreview();
        return;
      }
      // THE REVERSED DRAW (phase 89, D-02, BELT-01): no source at the pressed cell, but a free
      // Mechanical In's doorstep. The draw seeds there exactly as a source press does, and
      // records the In: `committedDraw` reverses the cells, so the preview and the release
      // both read the pressed doorstep as the belt's Head tile, docked into this In. Same
      // armed ring and same filled repaint as a source press (UI-SPEC 1.2).
      const inHit = inDoorstepPressHit(cam.screenToCell(p.x, p.y));
      if (inHit) {
        drawnCells = [doorstepCell(inHit.port)];
        drawnFrom = p;
        startIn = { node: inHit.handle, port: inHit.port };
        beltPointer = cam.screenToWorld(p.x, p.y);
        overlay.showNubRing({ x: inHit.x, y: inHit.y }, true);
        paintDockTargets();
        refreshBeltPreview();
        return;
      }
      const cell = cam.screenToCell(p.x, p.y);
      drawnCells = [[cell.cx, cell.cy]];
      drawnFrom = p;
      beltPointer = cam.screenToWorld(p.x, p.y);
      refreshBeltPreview();
      return;
    }
    // WIRE-02, and the placement is the whole contract (UI-SPEC 4.5). This branch
    // sits at the TOP of the function, immediately after the `beltArmed` block, and
    // ABOVE the rotate-handle / belt-handle ladder below. `beltArmed` is already the
    // first statement here for the same reason, so while a drawing tool is armed the
    // belt endpoint handles and the rotate handle are inert BY CONSTRUCTION and
    // nobody has to write a guard. A wire branch placed at or below the ladder
    // inherits that collision instead of avoiding it.
    if (wireArmed) {
      // The belt draw's button rules, where the wire shares the code (D-11): the middle button
      // pans and keeps the tool and any source; the right button drops an in-flight source and
      // keeps the tool, and with no source puts the tool away (IX-08).
      if (e.button === 1) {
        return;
      }
      if (e.button !== 0) {
        if (wireSource !== null) {
          cancelWireSource();
        } else {
          disarmWire();
        }
        return;
      }
      // A second down while a source is held never re-picks it.
      if (wireSource !== null) {
        return;
      }
      ownPointer(e, true);
      const p = toLocal(e);
      wireSource = null;
      overlay.clearRoute();
      overlay.clearNubRing();
      // THE PRESS-SIDE SPLIT (plan 66-09, the decision of 2026-08-26; the press rule
      // amended by plan 75-07, D-12, 2026-10-06). The rule is still one sentence:
      //
      //   EMISSION IS PREFERRED WHEREVER A COMMAND CAN BE FORMED, AND THE CLIENT
      //   AUTHORS A MESSAGE ONLY WHERE NO COMMAND EXISTS TO REFUSE.
      //
      // What 75-07 moved is WHICH presses form a command. From 66-09 to 75-07 a MECHANICAL
      // Out started the drag (with a non-accepting ring) and the release emitted, so the
      // host said MediumMismatch after the release. User report on the real binary: "dragging
      // wire from router doesn't work, becomes red whatever I do". A port that only takes
      // belts can be neither a wire's source nor its target, so no release from it could
      // ever be accepted, and D-12 decides the press forms no command. It is answered AT
      // THE PRESS: the reject flash over THAT port's cell says where, and
      // `onClientRefusal('BeltOnlyPort')` says why (`CLIENT_REFUSAL_COPY`, "That port takes
      // belts, not wires."). No `wireSource`, no nub ring, no corridor; the release sends
      // nothing. The host's MediumMismatch is not retired: it is what a release onto a
      // belt-only TARGET, from an electrical source, still gets.
      //
      // ONE PREDICATE. `mediumsCompatible(port.medium, MEDIUM_ELECTRICAL)` is the only
      // medium test here, read and never restated (Dock and the release ranker use the
      // same one). `fabrico-command/tests/draw_wire.rs` proves the host refuses a DrawWire
      // on every catalog port that test is false for, as source and as target, so the
      // sentence can never show for a port the host would wire.
      //
      // AN ELECTRICAL In (or Fault) PRESSED ALONE keeps the WHERE-only flash and no
      // sentence. There is no source to name and no one cause that is true in a sentence,
      // and both copy tables are closed with no default arm BY DESIGN: a generic
      // something-went-wrong line would be the Phase 64 silence wearing a different coat.
      //
      // Before 66-09 THREE presses produced nothing at all - no marker, no flash, no
      // message: a mechanical Out, an electrical In and a Fault nub. One of them, the
      // electrical In, is literally the gesture WINDOWS row 113 reports ("the user tried the
      // intuitive inverse ... that gesture is silently inert"). None of them is silent now.
      // THE WIDER RADIUS, AND IT IS THE POINT OF PLAN 66-06 (UI-SPEC 6.1). A wire tool
      // built as nub-press/nub-release INHERITS whatever target the belt path uses, and
      // that target - a 24px diameter at zoom 1 - is the one WINDOWS row 113 records a
      // user failing to hit, repeatedly, on the real binary. `wireNubHitRadiusWorld` is
      // the project's own 44px chrome floor applied to the canvas. The default radius is
      // left alone for readers 1 to 4 (see `nubsInRadius`).
      const hits = nubsInRadius(
        cam.screenToWorld(p.x, p.y),
        wireNubHitRadiusWorld(camScale()),
      );
      // The press-side RANKER: the nearest hit that can BE a wire's source, an ELECTRICAL
      // Out. One anywhere in range wins over any nearer port, so the refusal below can
      // never steal a press that could have started a valid wire (T-75-24), and the flash
      // arm means "no source is reachable at all", never "the nearest nub happens to be
      // something else".
      const src = hits.find(
        (h) => h.port.role === ROLE_OUT && mediumsCompatible(h.port.medium, MEDIUM_ELECTRICAL),
      );
      if (src) {
        // THE ONE CELL THAT MUST NOT BE COPIED FROM THE BELT. The belt seeds
        // `drawnCells` at the port's FACING cell (`cell_x + dx` above). A wire route
        // is seeded at the port's OWN world cell, because `manhattan_l` seeds
        // `vec![(fx, fy)]` from `from.cell` and `resolve_wire_dock` sets that cell
        // from `port_world`. Feeding the facing cell would make the ghost corridor
        // one cell shorter than the landed cable at each end.
        wireSource = {
          node: src.handle,
          portIndex: src.port.index,
          cell: [src.port.cell_x, src.port.cell_y],
          side: src.port.side,
          medium: src.port.medium,
        };
        // THE MARKER. Until 75-07 its accepting flag was computed from the source's
        // medium, because a mechanical Out could be acquired and got the cold ring. Since
        // 75-07 an acquired source is electrical by construction (the ranker above), so
        // the flag is always true and is passed as the literal: SIMPLIFIED, not kept.
        overlay.showNubRing({ x: src.x, y: src.y }, true);
      } else if (hits.length > 0) {
        // A nub was pressed and none in range can be a source. The flash goes over the
        // NEAREST one, and the sentence, when there is one, describes that same port.
        const pressed = hits[0];
        overlay.showRejectFlash(
          { cx: pressed.port.cell_x, cy: pressed.port.cell_y },
          { w: 1, h: 1, rot: 0 },
        );
        if (!mediumsCompatible(pressed.port.medium, MEDIUM_ELECTRICAL)) {
          // A port that only takes belts, any role (a Router's Out or In, a Fault drain).
          deps.onClientRefusal?.('BeltOnlyPort');
        }
        // Otherwise an electrical non-Out: the where-only answer, no sentence (above).
      }
      // REPAINT WITH THE RESOLVED SOURCE FILLED. At the 66-06 radius two Out nubs one
      // cell apart (32 world px) are both in range at their midpoint; `nubsInRadius`
      // ranks nearest-first so the resolution is deterministic, and this paint is what
      // makes it VISIBLE - the user sees which port they grabbed before they release.
      // An invisible disambiguation would be a worse defect than the small target.
      //
      // Unconditional, including when nothing was acquired: a press in open space is
      // still a no-op and the tool STAYS armed, so the resting set must survive it
      // rather than blink out. Giving that miss a VOICE (the press-side reject flash)
      // is 66-09; this only keeps the affordance honest about the current state.
      paintWireTargets();
      return;
    }
    if (placementKind !== null) {
      // IX-08/Pitfall-2: a right-click (any press but the left and the middle) is a
      // decisive cancel on POINTERDOWN, mirroring the Belt tool, so the OS context
      // menu that fires after the click can never open over a still-armed tool. THE
      // MIDDLE BUTTON PANS AND NEVER CANCELS (D-11, NAV-04, plan 89-10, seen on the
      // real-app walk): the camera pans on it whatever is armed (`camera.ts`), so the
      // machine tool stays armed, as the Belt and Wire tools do. A left press while
      // armed is a no-op (the place commits on the paired pointerup, which ignores a
      // middle release, WR-08).
      if (e.button !== 0 && e.button !== 1) {
        disarmPlacement();
      }
      return;
    }
    // THE RIGHT BUTTON CANCELS AN OUTPUT-DOT DRAG (UI-SPEC A14, D-11), nothing sent, every mark
    // cleared. Only the right one: the middle button's pan that keeps a drag is plan 89-07's.
    // A device that does send a right `pointerdown` mid-drag lands here; a mouse sends the chorded
    // move `onWinMove` cancels on (review CR-B-01). Both cancel the same set of drags.
    if (e.button === 2 && (outDrag !== null || outPress !== null || endPress !== null || handleDrag !== null)) {
      // The pending click goes too: a cancelled press selects nothing on its release.
      cancelIdleGesture();
      return;
    }
    // Every other non-left press returns here, so the middle button pans the camera and keeps
    // an output-dot drag, a handle drag and a ring drag in flight (UI-SPEC A14, D-11).
    if (e.button !== 0) {
      return;
    }
    const p = toLocal(e);
    // The press that starts a no-tool gesture owns it: another pointer cannot steer or end it.
    ownPointer(e, false);
    // STRANDED-RING PRESS (CONNECT-02) - the FIRST arm, ahead of the rotate
    // handle and ahead of hitHandle. 67-UI-SPEC 4.5 is BINDING: a stranded ring
    // appears independent of what, if anything, is selected, so it must be
    // reachable independent of selection, and it therefore needs its own
    // priority slot rather than a branch inside one of theirs. A ring can sit
    // visually near either competitor, so "first" is a press-PRIORITY ordering,
    // not merely a hit test.
    //
    // THE 4.5 RECONCILIATION, RECORDED HERE RATHER THAN BY AMENDING THE SPEC.
    // 4.5 says this test is NOT selection-gated, and it is not: the arm runs
    // first and its OUTCOME does not depend on what was selected. Assigning the
    // selection below is part of the press's EFFECT, not a precondition of it -
    // it is what makes the belt's endpoint handles visible after the drop, and
    // it is what lets the whole shipped drag/preview/release path run verbatim
    // (hitHandle's only precondition is `selection.kind === 'belt'`). Read the
    // assignment as satisfying the rule, not violating it.
    //
    // D-25 (Phase 64), named because the correct implementation here is the
    // ABSENCE of something: once `handleDrag` is set, NOTHING below re-reads the
    // ring set or the ring's clock. A decay must never retroactively invalidate
    // a gesture the user is actively completing, so the ring expiring (or being
    // cleared by an unrelated structural edit) mid-drag must not cancel the
    // drag. Do not add a TTL check to the drag; the tests in gestures.test.ts
    // are what stop a later edit adding one.
    const ring = hitStrandedRing(p.x, p.y);
    // RETIRE THE PAINTED RING FIRST, AND LET ITS ANSWER DECIDE (67-REVIEW WR-03).
    //
    // The record and the paint are two sets that must stay in step, and nothing
    // enforces that mechanically: today they agree only because App hands the same
    // `{x, y}` object literal to `overlay.showAlertRings` and to
    // `setStrandedRings`, and `clearAlertRingAt` matches on EXACT coordinate
    // equality. When the retire MISSES, this record names a ring that is not on
    // screen, so acting on it would start a drag from an affordance the user never
    // saw. Drop the stale record - which converges the pressable set back INTO the
    // painted one, the only safe direction - and fall through to the ordinary press
    // chain. This press then behaves exactly as it would have if the ring had never
    // been recorded.
    const ringRetired = ring !== null && overlay.clearAlertRingAt(ring.pt);
    if (ring !== null && !ringRetired) {
      strandedRings = strandedRings.filter((r) => r !== ring);
    }
    if (ring && ringRetired) {
      // `ev.end` VERBATIM off the StrandedDock record. 67-UI-SPEC 4.2's release
      // row names `Tail` in its EXAMPLE and in the same breath says to use the
      // event's own recorded BeltEnd and never to assume; the instruction is
      // what is honoured here, not the example.
      selection = { kind: 'belt', id: ring.beltId };
      // THE TWO LINES EVERY OTHER SELECTION SITE RUNS (67-REVIEW WR-02). This
      // arm CREATES a belt selection, and the only other place that does
      // (`onCanvasUp`'s belt branch) pairs it with exactly these two calls. The
      // `hitHandle` arm below needs neither because `selection.kind === 'belt'`
      // is its PRECONDITION - it never creates a selection - so "the same lines
      // hitHandle runs" was the wrong model to copy here.
      //
      // Without them, pressing a ring while a NODE was selected (the ordinary
      // state: the severing Rotate is normally performed on a selected node)
      // left the canvas still painting that node's outline and left App still
      // believing it was selected - so its ConfigPanel stayed open and
      // DeleteControl still targeted it - while the gesture layer believed a
      // belt was selected. The two selection models diverged until the next
      // Escape.
      overlay.clearSelection();
      deps.onSelect?.(null);
      // BELT-01: null on the BELT channel too. This arm sets `selection` to the
      // belt because the ring press STARTS A DOCK DRAG, not because the user asked
      // to configure it - a ring grab is a drag gesture, and opening a pace panel
      // under the pointer mid-drag is not what was asked for. The two channels
      // therefore agree here: neither is non-null.
      deps.onSelectBelt?.(null);
      // The SAME lines the hitHandle arm below runs - no second drag state
      // machine. Every downstream stage (in-drag dropCandidate + showNubRing,
      // the release emit, the refusal path) is unchanged and unaware of where
      // the drag came from.
      handleDrag = { beltId: ring.beltId, end: ring.end, fromRing: true };
      dropCandidate = null;
      // The in-flight DROP TARGETS (74-UI-SPEC 3.1): every port and belt end that could
      // accept THIS end lights the moment the drag starts, so the user is not dragging
      // at a target they cannot find - which is WINDOWS 140 and row 113 both.
      paintDockTargets();
      clearHandleHover();
      clearNubHover();
      clearStrandedHover();
      // This ring's job - saying "look here" - is DONE the moment it is grabbed,
      // and `showDraggedHandle` takes the point over unchanged. It was already
      // retired above; drop its record too so the pressable set stays exactly the
      // painted set. Any OTHER stranded ring stays: a single Rotate can strand more
      // than one belt and the others are still unanswered.
      strandedRings = strandedRings.filter((r) => r !== ring);
      cam.setPanEnabled(false);
      canvas.style.cursor = 'grabbing';
      return;
    }
    // Rotate-handle press (CTRL-03): while a NODE is selected, the handle takes
    // the press BEFORE the select chain (UI-SPEC z-order: the handle sits above
    // everything but the ghost). Consume it — no pan, no reselect; the Rotate
    // emits on the paired up if it lands still within the hit radius.
    if (selection?.kind === 'node' && rotateHandleHit(p.x, p.y)) {
      rotatePress = { node: selection.id };
      cam.setPanEnabled(false);
      return;
    }
    // Endpoint-handle drag start: while a belt is selected, hit-test BOTH
    // handle centers BEFORE the node/belt/floor priority chain (CTRL-01).
    if (selection?.kind === 'belt') {
      const grab = hitHandle(p.x, p.y);
      if (grab) {
        handleDrag = { beltId: selection.id, end: grab.end, fromRing: false };
        dropCandidate = null;
        // The in-flight drop targets, from the SAME primitive the armed tool uses
        // (74-UI-SPEC 3.1). Machine ports are in the set on purpose: ringing belt ends
        // alone would teach the user that belt ends are a special kind of target, when
        // the whole claim of this phase is that they stopped being special.
        paintDockTargets();
        clearHandleHover();
        clearNubHover();
        cam.setPanEnabled(false);
        canvas.style.cursor = 'grabbing';
        return;
      }
    }
    // THE OUTPUT DOT (phase 89, D-05, UI-SPEC 3.1): after the selected belt's end handle and
    // before the machine body, so a belt tile lying on that output's doorstep loses to the dot.
    // The press is a click on the machine (`down`, exactly what a body press records) until the
    // pointer leaves the dot's hit radius; `onWinMove` turns it into the drag then.
    const dot = outDotAt(p.x, p.y);
    if (dot) {
      cam.setPanEnabled(false);
      down = { kind: 'node', id: dot.node };
      outPress = { node: dot.node, port: dot.port.index, pt: { x: dot.x, y: dot.y }, at: cam.screenToWorld(p.x, p.y) };
      return;
    }
    const cell = cam.screenToCell(p.x, p.y);
    // Press priority (idle, no tool armed): node body FIRST, then belt tile,
    // then floor (deselect + pan).
    const node = nodeAtCell(getScene(), cell.cx, cell.cy);
    if (node) {
      // Press began on a node → candidate select; suspend pan for the gesture.
      cam.setPanEnabled(false);
      down = { kind: 'node', id: node.id };
      return;
    }
    const belt = beltAtCell(getScene(), cell.cx, cell.cy);
    if (belt) {
      // Press began on a belt tile → candidate BELT select (CTRL-01).
      cam.setPanEnabled(false);
      down = { kind: 'belt', id: belt.id };
      // AN UNSELECTED BELT'S END TILE STARTS THE SHIPPED HANDLE DRAG (phase 89, D-05, UI-SPEC
      // 3.1 last line): a press inside EXACTLY ONE end tile of a multi-tile belt, the rule
      // `hitHandle` applies to a selected belt, is a click until the pointer leaves that tile.
      // The selected belt's own ends never reach here: `hitHandle` took them above.
      if (belt.tiles.length >= 2) {
        const w = cam.screenToWorld(p.x, p.y);
        const inHead = inTile(belt.tiles, 'Head', w);
        const inTail = inTile(belt.tiles, 'Tail', w);
        if (inHead !== inTail) {
          endPress = { beltId: belt.id, end: inHead ? 'Head' : 'Tail' };
        }
      }
      return;
    }
    // Empty floor → let the camera own the pan; deselect on a bare click.
    if (selection !== null) {
      selection = null;
      overlay.clearSelection();
      overlay.clearBeltHandles();
      clearHandleHover();
      deps.onSelect?.(null);
      deps.onSelectBelt?.(null);
    }
  };

  const onWinMove = (e: PointerEvent): void => {
    if (isStranger(e)) {
      return;
    }
    const p = toLocal(e);
    if (beltArmed) {
      // THE OWNER'S BUTTONS DURING A DRAW (D-11, research Pitfall 7). A second button pressed
      // during a left drag arrives as a MOVE whose `buttons` changed, never as a down. The left
      // bit gone is a release the page never got (WINDOWS 245): the path is thrown away and lays
      // nothing, the tool stays; with the middle button still held this is the same lost release
      // (research A6), not a commit. The right bit is the right button pressed mid-draw: it
      // cancels the path and keeps the tool, as a right press does. The middle bit is the middle
      // button: it neither extends nor commits the path, so the sample adds no cell and only
      // carries the walk anchor along (no cell the hand crossed under it is walked later).
      if (drawnCells && (leftReleased(e) || rightChorded(e))) {
        dropBeltPath();
        return;
      }
      if (drawnCells && middleChorded(e)) {
        drawnFrom = p;
        return;
      }
      // THE BELT FOLLOWS THE CURSOR (plan 74-14). Each pointer sample closes a
      // SEGMENT with the previous one, and the accumulator walks the cells that
      // segment crossed, in crossing order, feeding each one through the per-cell
      // rule below. A hand that moves fast, or turns a corner (where it necessarily
      // has both velocity components for a stretch), emits samples two or more cells
      // apart; considering only the sample's own cell dropped every one of them, so
      // corners mostly did not draw and a skipped cell froze the path for good.
      //
      // The per-cell rule, in order, with `last` the current head:
      //   a  c is `last`                                  -> nothing
      //   b  length >= 2 and c is `drawnCells[length - 2]` -> POP the head
      //   d  manhattan(c, last) is 1                       -> PUSH c
      //   e  otherwise                                     -> nothing, and CONTINUE
      // There is no branch c any more; the letters are kept so the history reads.
      //
      // Branch b is the retreat: re-entering the cell immediately behind the head
      // pops the head, so a user who clipped a machine or overshot a corner recovers
      // with a wrist movement instead of losing the drag. It pops ONLY index
      // `length - 2`, so every DEEPER revisit still appends and still routes
      // SelfCrossing - the deliberate red is designed behaviour and survives.
      //
      // Branch d is the ONLY push, and the manhattan test on it is THE INVARIANT:
      // NO CELL WHOSE DISTANCE FROM THE CURRENT HEAD IS NOT EXACTLY 1 MAY EVER ENTER
      // `drawnCells`. That is what keeps `NonAdjacent` unreachable from a drag, which
      // is the premise `overlay.ts`'s retained-red repaint rests on (74-13): with the
      // invariant, SelfCrossing is the only typed reject a drag can produce. An edit
      // that pushes a walked cell without this test paints a stale red for a reason
      // the code no longer names.
      //
      // Branch e CONTINUES rather than aborting. A cell more than 1 from the head can
      // only arise after a retreat or an earlier branch-e skip in the same walk, and
      // skipping it while continuing is what lets a walk recover inside one sample
      // instead of stranding.
      //
      // A revisit deeper than one cell back IS adjacent to the last and gets
      // appended, route() then reports SelfCrossing and the preview goes red; the
      // release is still sent, so the host refuses it in words (D-13).
      //
      // BRANCH C IS DELETED (phase 74.1, D-03 as amended 2026-10-02). It was
      // the 74-13 exception for the PRESSED NODE: a nub press used to seed the draw one
      // cell beyond the tile the pointer stood in, so the first sample appended the
      // pressed thing's own tile backwards, and branch c declined that one cell while
      // the path was still its seed. Since 74.1 the press resolves BY CELL onto the
      // doorstep (`doorstepPressHit`) and seeds there, so the pointer starts IN the seed
      // and the first walked cell is the seed itself, which branch a ignores.
      //
      // What branch c still did after that move is the reason it is gone rather than
      // kept: it fired only when the hand went BACK into the pressed belt or machine
      // while the path was one cell long, and the release then committed a one-cell
      // stub docked behind the hand. That is a silent wrong result (a blue commit whose
      // head is not under the hand), and it was ruled out. Now that gesture appends the
      // occupied tile through branch d, the preview turns red, and the release is sent so
      // the host refuses it in words (D-13). Branches a, b, d and e and the adjacency
      // invariant are unchanged.
      if (drawnCells) {
        const from = drawnFrom ?? p;
        const walked = walkCellsBetween(from, p);
        let changed = false;
        for (const c of walked) {
          const last = drawnCells[drawnCells.length - 1];
          // (a) the cursor is still in the head's cell: a sub-cell sample.
          if (c[0] === last[0] && c[1] === last[1]) {
            continue;
          }
          // (b) THE RETREAT. The cell immediately behind the head, and ONLY that
          // one: `drawnCells.some(...)` here would delete the deliberate
          // SelfCrossing red, and `closing a loop onto the middle of your own path
          // still goes red` is the case that would redden.
          if (drawnCells.length >= 2) {
            const behind = drawnCells[drawnCells.length - 2];
            if (c[0] === behind[0] && c[1] === behind[1]) {
              drawnCells.pop();
              changed = true;
              continue;
            }
          }
          const manhattan = Math.abs(c[0] - last[0]) + Math.abs(c[1] - last[1]);
          // (d) THE ONLY PUSH, carrying THE INVARIANT (see the head of this block).
          // NO occupancy test belongs here: `beltPathLegal` is false for a
          // self-crossing candidate too, so reusing it would silently delete the
          // deliberate red - so a swept machine tile means a red preview and a release
          // the host refuses in words (D-13), never a silent commit. The
          // control that reddens on a guard widened this way is `a draw that crosses
          // an occupied tile still appends it and previews red`.
          if (manhattan === 1) {
            drawnCells.push([c[0], c[1]]);
            changed = true;
            continue;
          }
          // (e) further than 1 from the head: skip it and KEEP WALKING.
        }
        // ONE preview call per sample, and only when the path moved. Nothing in
        // either suite reads the call frequency; `beltCalls` is asserted through
        // `.at(-1)` and one `.filter`, never as a count, except in the bound case
        // where the ABSENCE of a call is the subject.
        //
        // THE ONE OTHER REASON TO REPAINT (74.1-08): the path did not move but the
        // pointer moved onto or off an In nub (or, for a reversed draw, an Out dot), so
        // what the release would commit changed: the docked end, its seam kind, or its
        // appended doorstep. `answerMoved` asks the release's own question
        // (`committedDraw`) of this sample and repaints only on a different answer.
        beltPointer = cam.screenToWorld(p.x, p.y);
        if (changed || answerMoved()) {
          refreshBeltPreview();
        }
        drawnFrom = p;
      } else {
        // Armed but not drawing: the resting set is RECOMPUTED here on every move,
        // from the live scene, rather than cached at arm time - the same T-66-06-02
        // reasoning the wire branch below states. `scene.belts` holds DENSE render
        // handles and a full keyframe rebuilds that table from zero, so a cached list
        // would keep painting rings at stale positions with no gesture and no warning.
        paintDockTargets();
      }
      return;
    }
    // WIRE-02: the in-drag preview. Same TOP placement, same reason, as the
    // `beltArmed` branch above (see the note in onCanvasDown).
    if (wireArmed) {
      // Armed but not dragging: there is no corridor to preview, but the RESTING
      // affordance is recomputed here on every move, from the live scene, rather than
      // cached at arm time (T-66-06-02). `scene.nodes` holds DENSE render handles and a
      // full keyframe rebuilds that table from zero, so a cached list paints rings at
      // stale positions with no gesture and no warning. Recomputing makes the ring set
      // a pure projection of the current scene and immune to the remint BY
      // CONSTRUCTION, which is the same reasoning the D1 lane key uses to avoid needing
      // a wire identity. It is cheap: an allocation and a nub walk at pointer rate,
      // the same order as the hit test one line below.
      if (!wireSource) {
        paintWireTargets();
        return;
      }
      // The belt draw's lost-release and right-chord rules, for the wire's source (D-11).
      if (leftReleased(e) || rightChorded(e)) {
        cancelWireSource();
        return;
      }
      const hits = nubsInRadius(
        cam.screenToWorld(p.x, p.y),
        wireNubHitRadiusWorld(camScale()),
      );
      // The RANKER (never a gate, CR-01): the nearest ACCEPTING hit, falling back to
      // the nearest Role::In hit, falling back to the nearest hit of any kind. Role
      // used to FILTER the hit set before ranking, which emptied it on an Out or
      // Fault release and painted the corridor's fallback (the pointer's own cell)
      // instead of the nub the pointer was actually over -- a command CAN be formed
      // against any nub in radius, so the preview names it. `nubsInRadius` is sorted
      // nearest-first and its sort is stable, so equal distances keep node-then-port
      // enumeration order. This is the same `hits.find(accepts) ?? hits[0]` shape the
      // dock release uses.
      const target =
        hits.find((h) => acceptsWireTarget(h.port)) ??
        hits.find((h) => h.port.role === ROLE_IN) ??
        hits[0] ??
        null;
      // With no nub acquired the corridor still has to end somewhere, so it ends at
      // the pointer's own cell.
      //
      // THE SIDE IS NO LONGER FREE, corrected 2026-09-03 by plan 72-15. This comment
      // used to say `manhattan_l` reads only the two CELLS, so any side produced the
      // identical corridor. That was true from Phase 40 to Phase 72 and is the exact
      // blindness that let a cable enter a machine through its underside. `wireRoute`
      // now reads BOTH sides, so the side chosen here CHANGES THE PREVIEWED SHAPE:
      // `oppositeSide(wireSource.side)` faces the corridor back at its source, which
      // makes both faces admissible on the same axis and previews a Z rather than a
      // bare L whenever the pointer is off the source's row.
      //
      // It remains the honest choice, and now for a stronger reason than before: it is
      // the side a facing target would present, so the free-drag ghost shows the shape
      // the user gets if they release on the kind of port they are plainly reaching for.
      // A ghost that previewed a bare L and then landed a Z would be the preview-commit
      // divergence the paragraph below exists to prevent.
      const cell = cam.screenToCell(p.x, p.y);
      // THE SYNTHETIC SIDE NOW HAS A SECOND CONSEQUENCE, and it is the one thing in
      // 72-16 most likely to read as worse than the bug it fixes. With nothing
      // acquired the synthetic target side is `oppositeSide(wireSource.side)`, so
      // `nt === f` and the ring's D2 gate collapses to "is the pointer in the
      // half-plane the port faces". MEASURED, 3x3 Handler with an E-facing Out at
      // (5,0), pointer swept over [-8,8] squared: the ring fires on 152 of 288
      // pointer cells, 53 percent of the drag plane, and the longest free-drag ghost
      // is 23 cells. Drag anywhere BEHIND an east-facing port and today's short L
      // becomes a full loop that follows the cursor.
      //
      // PREVIEW STILL EQUALS COMMIT, which is the rule that matters and the reason
      // this was not special-cased: the ghost shows exactly the shape release will
      // mint. The ghost is drawn against a fictitious 1x1 target body that snaps to
      // the real rectangle the instant a target is acquired, which is the same
      // honesty the paragraph above claims for the side.
      const toDock = target
        ? {
            cell: [target.port.cell_x, target.port.cell_y] as [number, number],
            side: target.port.side,
            // A REAL rectangle the instant a nub is acquired: `NubHit` carries the
            // whole `NodeView` for a MACHINE port, so this is the same resolved body
            // the host packet's own dock carries. The null arm is unreachable on this
            // path - the wire hit test scans `'ports'` only (T-74-22) - and it degrades
            // to the degenerate one-cell rectangle rather than asserting, because a
            // throw inside a pointer handler is worse than a slightly wrong ghost.
            body: target.node ? bodyOfNode(target.node) : cellBody(target.port.cell_x, target.port.cell_y),
          }
        : {
            cell: [cell.cx, cell.cy] as [number, number],
            side: oppositeSide(wireSource.side),
            // NO MACHINE BEHIND THE POINTER, so the degenerate rectangle: the body IS
            // the pointer cell.
            body: cellBody(cell.cx, cell.cy),
          };
      // The corridor the LANDED cable will take, not a straight rubber band:
      // `wireRoute` is the byte-pinned TS mirror of the Rust router the host
      // re-derives from the two docks on every packet, so preview == commit.
      // THE LANE KEY IS COMPUTED FROM THE SAME `geometry.tiles` THE LANDED CABLE IS
      // KEYED ON, through the same `cableLane`, so the ghost previews the corridor the
      // cable will actually take (D1, 66-UI-SPEC 5.1). This is only possible because the
      // key is a pure function of the ROUTE and needs no wire identity - during the drag
      // the wire has none at all. A key that needed one (the dense render handle was the
      // only candidate) could never have been previewed, which is why the
      // `fabrico-command` corridor offset was rejected. `ghostLeg` is the ONE expression
      // that does both, for this leg and for the paired one alike.
      const srcNode = getScene().nodes.get(wireSource.node);
      const leg = ghostLeg(
        {
          cell: wireSource.cell,
          side: wireSource.side,
          body: srcNode
            ? bodyOfNode(srcNode)
            : cellBody(wireSource.cell[0], wireSource.cell[1]),
        },
        toDock,
      );
      if (leg) {
        const accepts = target !== null && wirePredictsAccept(wireSource, target.port);
        // THE PAIR IS PREVIEWED ONLY OVER A LEGAL TARGET (R-70). With nothing acquired
        // the corridor already ends at the pointer's own cell and promises nothing, so
        // there is no second leg to promise either.
        const pair: PairPreview =
          accepts && target !== null && target.node !== null
            ? pairPreview(wireSource, { ...target, node: target.node })
            : { kind: 'none' };
        // THE CORRIDOR'S TWO ENDS (plan 75-05, D-08, CABLE-08), handed over on every call
        // because `showRoute` requires them. The source end is the pressed port's nub;
        // the target end is the acquired port's nub, or `NO_NUB` while nothing is
        // acquired, so the free corridor still ends on the pointer's own cell centre
        // (75-UI-SPEC 3.1). The overlay places them with the same `cablePoints` builder
        // the landed cable is drawn with, so the preview starts and stops where the
        // cable will.
        const nubs: CableNubs = {
          from: nubEndAt(wireSource.cell[0], wireSource.cell[1], wireSource.side),
          to: target ? nubEndAt(target.port.cell_x, target.port.cell_y, target.port.side) : NO_NUB,
        };
        overlay.showRoute(
          leg.path,
          nubs,
          accepts && pair.kind !== 'refused',
          leg.lane,
          pair.kind === 'pair' ? [{ path: pair.leg.path, lane: pair.leg.lane, nubs: pair.nubs }] : [],
        );
      } else {
        overlay.clearRoute();
      }
      return;
    }
    if (placementKind !== null) {
      // Track the latest point so a keyboard 'r' can re-render the rotated
      // ghost at the cursor without waiting for the next move (CTRL-03).
      lastMovePoint = { x: p.x, y: p.y, overCanvas: e.target === canvas };
      // Only show the build ghost while the cursor is over the canvas floor, so it
      // never floats over the palette/chrome during a press that hasn't yet
      // dragged onto the grid.
      //
      // `hide()`, NOT `clear()`: this branch means "nowhere to draw", never
      // "put the tool down". `clear()` also nulls the ghost's armed footprint,
      // and arming from the palette leaves the cursor ON the palette — so the
      // very next move disarmed the footprint and nothing re-set it on canvas
      // re-entry. The ghost then fell back to 1x1 for BOTH its occupancy check
      // and its silhouette: a solid blue single cell inviting a 2x3 drop the
      // host would refuse. The real disarms (disarmPlacement / armBeltDraw)
      // still call `clear()`.
      if (e.target === canvas) {
        ghost.moveTo(p.x, p.y);
      } else {
        ghost.hide();
      }
      return;
    }
    // A no-tool press or drag whose release the page never got (plan 89-07, the 89-06 carry-over):
    // it ends with nothing sent, so a later release cannot dock or select from a stale gesture.
    if (leftReleased(e) && cancelIdleGesture()) {
      return;
    }
    // THE RIGHT BUTTON CANCELS A NO-TOOL DRAG (UI-SPEC A14, review CR-B-01). A right press while
    // the left is held reaches the page as THIS move, its `buttons` gaining bit 2, never as a
    // `pointerdown`, so the `onCanvasDown` right-button branch cannot see it with a mouse. Every
    // drag of a belt end goes, nothing sent: the output-dot press and drag, an unselected belt's
    // end-tile press and the handle or ring drag it becomes (UI-SPEC 3.1: the same marks, so the
    // same cancel). A plain body press is not a drag and is left alone.
    if (
      rightChorded(e) &&
      (outDrag !== null || outPress !== null || endPress !== null || handleDrag !== null) &&
      cancelIdleGesture()
    ) {
      return;
    }
    if (handleDrag) {
      // Dock drag in flight: the dragged handle follows the cursor in WORLD px
      // (render-side floats only — they never enter the encoder payload,
      // T-21-10) and the live drop candidate + nub ring are re-evaluated.
      const w = cam.screenToWorld(p.x, p.y);
      overlay.showDraggedHandle(w);
      updateDropCandidate(w);
      // Recomputed on every move for the reason the armed branch above gives: a list
      // captured at press time would strand rings at stale positions across a keyframe.
      paintDockTargets();
      return;
    }
    if (outDrag) {
      // The output-dot drag in flight: the same three paints as the handle drag above.
      const w = cam.screenToWorld(p.x, p.y);
      overlay.showDraggedHandle(w);
      updateOutDropCandidate(w);
      paintDockTargets();
      return;
    }
    if (outPress) {
      // A click on the dot until the pointer leaves its hit radius (UI-SPEC A11) AND has travelled
      // the drag slop from where it pressed (review WR-B-04, a refinement of A11).
      const w = cam.screenToWorld(p.x, p.y);
      const r = nubHitRadiusWorld(camScale());
      const dx = w.x - outPress.pt.x;
      const dy = w.y - outPress.pt.y;
      const slop = OUT_DRAG_SLOP_PX / camScale();
      if (dx * dx + dy * dy <= r * r || Math.hypot(w.x - outPress.at.x, w.y - outPress.at.y) < slop) {
        return;
      }
      // It left: the drag begins, and the select candidate is dropped.
      outDrag = { node: outPress.node, port: outPress.port };
      outPress = null;
      down = null;
      outDropBelt = null;
      clearHandleHover();
      clearNubHover();
      clearNubCursor();
      overlay.clearHover();
      canvas.style.cursor = 'grabbing';
      overlay.showDraggedHandle(w);
      updateOutDropCandidate(w);
      paintDockTargets();
      return;
    }
    if (endPress) {
      // A click on the belt's end tile until the pointer leaves that tile; then the shipped
      // handle drag, exactly as a selected belt's end tile starts it, the selection untouched.
      const w = cam.screenToWorld(p.x, p.y);
      const pressed = endPress;
      const belt = getScene().belts.get(pressed.beltId);
      if (belt && inTile(belt.tiles, pressed.end, w)) {
        return;
      }
      endPress = null;
      if (!belt) {
        return;
      }
      handleDrag = { beltId: pressed.beltId, end: pressed.end, fromRing: false };
      dropCandidate = null;
      down = null;
      clearHandleHover();
      clearNubHover();
      clearNubCursor();
      overlay.clearHover();
      canvas.style.cursor = 'grabbing';
      overlay.showDraggedHandle(w);
      updateDropCandidate(w);
      paintDockTargets();
      return;
    }
    if (down) {
      // A press is in progress on a node — suppress idle hover. The former
      // node->node Wire drag preview was removed in Phase 17-02; a drag here no
      // longer routes or wires anything (release still resolves to a select).
      return;
    }
    // Idle hover: the rotate-handle affordance FIRST when a node is selected
    // (UI-SPEC z-order — the handle sits above everything but the ghost, so
    // the nub-ring priority must not clobber it), then the belt endpoint
    // handle-hover (section 3), then nub hover, then the soft node ring.
    if (e.target === canvas) {
      // STRANDED-RING HOVER (CONNECT-02) - resolved FIRST within the idle-hover
      // section, mirroring the press priority in onCanvasDown. A cue that
      // appeared for an affordance the press would not serve would be a lie
      // about what the click does, so the hover ordering and the press ordering
      // are the same ordering.
      //
      // NO `!handleDrag` GUARD HERE, DELIBERATELY, and the absence is the point:
      // the whole idle-hover section already sits BELOW the `if (handleDrag)`
      // early return above, so a drag in flight never reaches this line. A
      // guard written here would read as load-bearing while being dead code -
      // and a test written against it survives deleting it, which is a check
      // that cannot fail. What keeps the cue off the screen mid-drag is the
      // PLACEMENT of this branch, and that is what the unit case asserts.
      const hoverRingHit = hitStrandedRing(p.x, p.y);
      if (hoverRingHit) {
        // CLEAR THE COMPETING AFFORDANCES FIRST, THEN PAINT (67-REVIEW WR-01).
        // The order is load-bearing and it is the ONE thing that separates this
        // branch from its siblings below, which clear only children this branch
        // does not touch. `clearHandleHover` calls `overlay.clearHandleRing()`
        // and resets a 'pointer' cursor - and the stranded cue REUSES that same
        // `handleRing` Graphics child (see `showHandleRing` below). Painting
        // first and clearing second therefore erased the ring and the cursor in
        // the same handler, for every move that arrived from a selected belt's
        // endpoint handle. Nothing below re-paints until the next pointermove.
        overlay.clearHover();
        clearRotateHover();
        clearHandleHover();
        clearNubHover();
        strandedHover = true;
        // The identical geometry the endpoint handle's hover already draws
        // (r=8, stroke 1.5px, pal.hover), layered over the still-pulsing fault
        // ring by the existing z-order. No new child, no new colour.
        overlay.showHandleRing(hoverRingHit.pt);
        // Matches hitHandle's hover cursor: the same promise, so the same cue.
        canvas.style.cursor = 'pointer';
        return;
      }
      clearStrandedHover();
      if (rotateHandleHit(p.x, p.y)) {
        rotateHover = true;
        overlay.setRotateHandleHover(true);
        canvas.style.cursor = 'pointer';
        overlay.clearHover();
        clearNubHover();
        return;
      }
      clearRotateHover();
      const grab = hitHandle(p.x, p.y);
      if (grab) {
        handleHover = true;
        overlay.showHandleRing(grab.pt);
        canvas.style.cursor = 'pointer';
        overlay.clearHover();
        clearNubHover();
        return;
      }
      clearHandleHover();
      // Nub hover priority (D-10, UI-SPEC section 4): a nub within the hit
      // radius shows the passive nub ring and SUPPRESSES the body hover ring.
      const w = cam.screenToWorld(p.x, p.y);
      const nub = nearestNub(w);
      if (nub) {
        nubHover = true;
        overlay.showNubRing({ x: nub.x, y: nub.y }, false);
        overlay.clearHover();
        // The grab cue only where the output-dot drag starts (UI-SPEC A12, A13): the press
        // reads the same `outDotAt`, so the cue and the press agree.
        if (outDotAt(p.x, p.y)) {
          nubCursor = true;
          canvas.style.cursor = 'pointer';
        } else {
          clearNubCursor();
        }
        return;
      }
      clearNubHover();
      clearNubCursor();
      const cell = cam.screenToCell(p.x, p.y);
      if (nodeAtCell(getScene(), cell.cx, cell.cy)) {
        overlay.hoverRing(cell);
      } else {
        overlay.clearHover();
      }
    } else {
      clearRotateHover();
      clearStrandedHover();
      clearHandleHover();
      clearNubHover();
      clearNubCursor();
      overlay.clearHover();
    }
  };

  const onWinUp = (e: PointerEvent): void => {
    if (isStranger(e)) {
      return;
    }
    if (beltArmed) {
      // Only the left button's release commits a draw (D-11): a middle or right release is not it.
      if (drawnCells !== null && typeof e.button === 'number' && e.button !== 0) {
        return;
      }
      // Release: emit exactly ONE DrawBelt on EVERY release that has cells, legal or not (phase
      // 89, D-13, FAIL-02): the host validates regardless (T-14-ROUTE-CMD) and its typed refusal
      // says why. The tool STAYS armed for the next draw; Esc/right-click disarms. Cells are
      // integer grid coords only - no float leak (T-14-FLOAT-LEAK).
      const drawn = drawnCells;
      // The release asks `committedDraw` before the gesture's own state is cleared: it reads
      // `startDock`, `startFeed` and `startIn`.
      const committed = drawn === null ? null : committedDraw(drawn, cam.screenToWorld(toLocal(e).x, toLocal(e).y));
      drawnCells = null;
      drawnFrom = null;
      startDock = null;
      startFeed = null;
      startIn = null;
      beltPointer = null;
      overlay.clearNubRing();
      // A pointerup with NO draw in progress (a click on the toolbar's Play button, say) is not
      // this tool's release: it sends nothing and touches nothing; held pictures live on their
      // own surface either way (74.1-30).
      if (committed === null) {
        return;
      }
      // WHAT THIS RELEASE COMMITS is `committedDraw`'s answer: ONE closure the preview asks
      // too (74.1-08, phase 89 Pitfall 5), so the ghost and the commit cannot disagree about
      // the cells, the Head dock or the Tail dock. Its docblock carries the rules.
      // A path past the length cap is sent cut to one tile past it (research A4, T-89-22): the
      // host still answers BeltTooLong, and the frame stays far under `MAX_GESTURE_FRAME`, where
      // an unbounded walk sent whole could drop the transport instead of earning a sentence. The
      // verdict and the flash read the cells that are sent, so they name what the host will see.
      const cells = committed.cells.length > MAX_BELT_TILES + 1 ? committed.cells.slice(0, MAX_BELT_TILES + 1) : committed.cells;
      // THE VERDICT FIRST, THEN ONE FLASH (phase 89, plan 89-09, D-12, WINDOWS 250, UI-SPEC
      // 6.2). An illegal path flashes the cell the host's first failing check is about
      // (`beltPathVerdict`); only a LEGAL path flashes the dot of a Head dock the mirror
      // predicts refused (an Electrical In, WR-02, or the D-04 last-resort hit, A23). Until this
      // plan the nub flash ran before the legality gate, so an illegal path released on an
      // Electrical In flashed a port the host was never asked about. The flash says WHERE and
      // never carries a reason (D-10); one cell, whatever the occupant's size (A17).
      const verdict = beltPathVerdict(cells);
      const flash = verdict.legal ? committed.flash : verdict.blame;
      if (flash !== null) {
        overlay.showRejectFlash(flash, { w: 1, h: 1, rot: 0 });
      }
      if (!verdict.legal) {
        // A PREDICTED-ILLEGAL SEND (D-13, UI-SPEC 6.3): the cells the last preview painted, sent
        // so the host answers FootprintCollision, OutOfBounds, BeltTooLong or RouteSelfCrossing
        // in words (on a paused board, when it drains them at Play). It carries NO claim (it
        // would mark free cells taken until the host answered, for a draw the host will refuse),
        // arms no follow-up, no owed Docks, no held picture and no predicted seam, and the
        // preview clears now. If the host accepts it after all, the belt lands undocked and that
        // is the host's answer. A press just inside a machine's edge is this case with no extra
        // code: its seed is the machine's own cell.
        overlay.clearBeltPreview();
        if (cells.length > 0) {
          sendInput(encodeGridCommand({ kind: 'DrawBelt', cells }));
        }
        return;
      }
      if (evalBeltPath(committed)) {
        // The entry armed below is keyed by this DrawBelt's gesture id (phase 88, D-06), so
        // it pairs with its own verdict and never with a later identical redraw (WR-05), and
        // leaves every other committed belt's entry, picture and owed Docks alone (74.1-30,
        // PAUSE-SECOND-DRAW).
        //
        // ITS CLAIM (phase 88, plan 88-07, BELT-06, D-09): the routed tiles and the source its
        // Tail will dock, registered by the send seam under the id it returns. Until the
        // DrawBelt's answer ends it, the one occupancy read counts those cells and that source
        // as taken, so a second paused draw over them or off the same doorstep is red, and is
        // sent with no claim of its own so the host refuses it in words on Play (D-13). For a
        // reversed draw (D-02) the source is the Out or Fault the hand end docks.
        const routed = route(cells);
        const claimTiles: Array<[number, number]> = routed.ok
          ? routed.tiles.map((t) => [t.cell_x, t.cell_y])
          : cells.map(([x, y]) => [x, y]);
        const sDock = committed.tail;
        const drawId = sendInput(encodeGridCommand({ kind: 'DrawBelt', cells }), {
          claim: beltClaim(claimTiles, sDock ? { node: sDock.node, port: sDock.portIndex } : null),
        });
        // An id of 0 is nothing sent (no transport, phase 88 review IN-05): no verdict will
        // answer it, so no held picture, no owed Docks and no predicted seam wait for one.
        if (drawId === 0) {
          overlay.clearBeltPreview();
          return;
        }
        // Follow-up docks ride the echo watcher, NEVER this handler (the belt
        // handle does not exist yet - Finding 4). Wire-end mapping per the
        // keyspace note at startDock: the Tail dock first, then the Head dock.
        if (routed.ok) {
          const tiles: [number, number][] = routed.tiles.map((t) => [
            t.cell_x,
            t.cell_y,
          ]);
          const docks: Array<{
            end: BeltEnd;
            node: number;
            portIndex: number;
          }> = [];
          if (committed.tail) {
            docks.push({ end: 'Tail', ...committed.tail });
          }
          // The Head dock: the In the pointer hit, else the D-14 auto-dock (exactly one
          // `dockCandidates` In the routed head faces; 0 or 2+ is no dock and no chooser),
          // else for a reversed draw the pressed In. All of it is `committedDraw`'s answer.
          if (committed.head) {
            docks.push({ end: 'Head', ...committed.head });
          }
          // THE PICTURE OF THE COMMITTED BELT, BUILT ONCE (plan 74.1-30, walk item S1R).
          // The routed tiles re-kinded at the two ends the way the host will draw them
          // once the pending docks land: the Tail by the feed and the Head by the drain of
          // this release's committed answer (`committed`, computed before the gesture's
          // state was cleared). Until 74.1-30 the release instead held the drag preview,
          // which was repainted reading the CLEARED feed, so the seam showed route()'s
          // Straight on the first frame after every docked release and for the whole pause
          // when paused. ONE value, shared by the held picture and the pending-seam record,
          // so the picture before the echo and the drawn seam after it cannot disagree.
          // Since phase 89 (Pitfall 5) it is exactly the tile run the last preview showed,
          // an appended In doorstep (WR-09) included, because both read `committedDraw`.
          const picture = seamEndTiles(routed.tiles, committed.feed === null ? [] : [committed.feed], committed.drain);
          // The drag preview is the hand's gesture and ends here; from now until the
          // echo the belt is pictured on the overlay's held surface (74.1-26 held the
          // drag preview itself, so a new drag erased it). The entry is armed for EVERY
          // committed DrawBelt, with an empty dock list when nothing docks, and its
          // picture clears in the frame its accept and a packet holding the minted belt
          // are both in, at its own refusal or discard, at the lost-verdict fallback
          // (playing ticks only), on a keyframe, or on teardown.
          // Render-only: nothing in the decoded scene or on the wire reads it.
          overlay.clearBeltPreview();
          armBeltFollowUp(drawId, tiles, docks, picture);
          if (docks.length > 0) {
            // THE CORNER, HELD UNTIL THE DOCK ECHOES (74.1-20, review WR-05). The held
            // picture clears when the DrawBelt echoes and the Docks go out then, so
            // without this the belt is drawn with route()'s Straight at the seam (the
            // T) until the Dock folds. The renderer draws THESE kinds for the committed
            // cells until each expected end carries its dock, the DrawBelt or a Dock is
            // refused, the fallback passes (playing ticks only), a keyframe arrives, or a
            // later draw with exactly these cells replaces the record.
            // Render-only: nothing here reaches the wire or the decoded scene.
            recordPendingSeams({
              cells: tiles,
              tiles: picture,
              expect: {
                Tail: docks.some((d) => d.end === 'Tail'),
                Head: docks.some((d) => d.end === 'Head'),
              },
              tick: getScene().tick,
              ttlTicks: ECHO_TTL_TICKS,
              owner: drawId,
            });
          }
          return;
        }
      }
      overlay.clearBeltPreview();
      return;
    }
    // WIRE-02: the release. Same TOP placement, same reason, as the `beltArmed`
    // branch above (see the note in onCanvasDown).
    if (wireArmed) {
      if (wireSource !== null && typeof e.button === 'number' && e.button !== 0) {
        return;
      }
      const src = wireSource;
      wireSource = null;
      overlay.clearRoute();
      if (!src) {
        return;
      }
      const p = toLocal(e);
      const hits = nubsInRadius(
        cam.screenToWorld(p.x, p.y),
        wireNubHitRadiusWorld(camScale()),
      );
      // CR-01: role used to GATE this ranker (a `.filter(role === ROLE_IN)` ahead of
      // the find below), so a release squarely on an Out or Fault nub found an empty
      // hit set and emitted NOTHING -- no DrawWire, no refusal sentence, just a
      // where-only flash. A command CAN be formed against any nub the pointer
      // released on (the target's node id and port index exist for an Out exactly as
      // they do for an In), so it IS formed. Role now only RANKS which reachable hit
      // is preferred; it can never again empty the hit set.
      const target =
        hits.find((h) => acceptsWireTarget(h.port)) ??
        hits.find((h) => h.port.role === ROLE_IN) ??
        hits[0] ??
        null;
      // THE RANKER PICKED WHAT. IT DOES NOT PICK WHETHER. Everything below this line
      // is either an emission that happens regardless of the prediction, or a paint.
      if (target) {
        // EMITTED UNCONDITIONALLY, whether or not the ranker accepts it (Phase 64
        // D-07/D-08). Client-side re-validation before emit was REMOVED because a
        // locally-swallowed gesture produced no dock, no flash and no log line. The
        // ranker picked WHAT this release addresses; the host decides WHETHER, and
        // its typed refusal is what the user reads.
        //
        // `PortView.index` is passed VERBATIM: the host does
        // `view.ports_of(id).get(port as usize)` - a positional index into the
        // declared port list - and the render packet emits `PortView { index: i }`
        // from `.iter().enumerate()` over that same list. No FAULT_PORT sentinel and
        // no Out-routing-key translation: both belong to the Dock path only.
        sendInput(
          encodeGridCommand({
            kind: 'DrawWire',
            from_node: src.node,
            from_port: src.portIndex,
            to_node: target.handle,
            to_port: target.port.index,
          }),
        );
        if (!wirePredictsAccept(src, target.port)) {
          // THE WHERE, AND ONLY THE WHERE (UI-SPEC 6.4, locked by 64-UI-SPEC). The
          // canvas flash says WHERE and never carries a reason; the host's typed tag
          // says WHY through REFUSAL_COPY and never carries a location. This is the
          // belt's own release shape at the WR-02 site verbatim: record, emit, flash
          // over the NUB cell, and let the host answer.
          //
          // Over the NUB's cell rather than the pointer's, because the nub is what
          // the command named. At the 66-06 radius the two can differ by a cell.
          //
          // NO EIGHTEENTH TAG, and none of the four is reworded or given a recovery
          // clause. The host's DrawWire arm returns exactly UnknownNode,
          // IncompatiblePorts, MediumMismatch and PortOccupied, all four of which
          // already carry authored copy. `PortOccupied` waits for the explicit
          // disconnect verb in Phase 67 for its recovery clause and this is not that
          // phase; `MediumMismatch` is shared with the Dock path and its wording is
          // load-bearing there too.
          overlay.showRejectFlash(
            { cx: target.port.cell_x, cy: target.port.cell_y },
            { w: 1, h: 1, rot: 0 },
          );
        }
      } else {
        // A release on NOTHING. Nothing is emitted, because there is no port to name
        // and forging one would be the client inventing a target the user never
        // aimed at - and the flash goes over the cell the pointer was actually
        // released on, which is the only honest WHERE available.
        //
        // This is the row WINDOWS row 113 is about, and it is no longer silent. The
        // feedback is not one event either: the corridor was RED for every frame of
        // the drag (the pointer was never on an accepting nub) and the release adds
        // the 180ms fault decay over the cell.
        const cell = cam.screenToCell(p.x, p.y);
        overlay.showRejectFlash({ cx: cell.cx, cy: cell.cy }, { w: 1, h: 1, rot: 0 });
      }
      // The source marker dies with the drag that painted it. The tool STAYS armed so
      // a user can draw several, exactly as the Belt tool does; `wireSource` was
      // nulled at the top of this branch, so the repaint drops the fill and restores
      // the full resting set, which is what makes "draw several" legible rather than
      // merely possible.
      overlay.clearNubRing();
      paintWireTargets();
      return;
    }
    if (placementKind !== null) {
      finishPlacement(e);
      return;
    }
    // A middle or right release is not the release of a no-tool drag either (D-11): the middle
    // button pans and keeps an output-dot, end-tile or handle drag in flight (UI-SPEC A14).
    if (
      typeof e.button === 'number' &&
      e.button !== 0 &&
      (handleDrag !== null || outDrag !== null || outPress !== null || endPress !== null)
    ) {
      return;
    }
    if (rotatePress) {
      // Rotate-handle click (CTRL-03 / D-13): the paired up still within the
      // hit radius emits exactly ONE Rotate — the SAME frame shape as the
      // keyboard path. Shift+click = CCW (mirrors Shift+R). An up outside the
      // radius emits nothing (press consumed, gesture cancelled).
      const press = rotatePress;
      rotatePress = null;
      cam.setPanEnabled(true);
      const pt = toLocal(e);
      if (rotateHandleHit(pt.x, pt.y)) {
        // The SAME send as the R key, flash included (plan 74.1-25, review WR-04).
        sendRotate(press.node, e.shiftKey);
      }
      return;
    }
    if (handleDrag) {
      // Dock-drag release. Emit exactly ONE Dock IFF the live drop candidate is
      // set — which since Phase 64 means "the pointer was over SOME reachable
      // nub", accepting or not. A release over empty floor still addresses
      // nothing and emits nothing. `port` is the SPATIAL CATALOG index
      // verbatim (PortView.index) — the HOST owns the Out-routing-key /
      // FAULT_PORT translation at freeze time (D-11; duplicating it TS-side is
      // the Pitfall-6 bug). Success confirmation is the echoed diff re-emitting
      // the belt with the new dock — no spinner, no timeout (Finding 1); the
      // belts layer redraws the connector from the echo.
      const drag = handleDrag;
      const cand = dropCandidate;
      handleDrag = null;
      dropCandidate = null;
      cam.setPanEnabled(true);
      if (canvas.style.cursor === 'grabbing') {
        canvas.style.cursor = '';
      }
      overlay.clearDraggedHandle();
      overlay.clearNubRing();
      // THE TERMINUS. The drop targets die with the drag, exactly as `clearWireTargets`
      // fires at every wire-gesture terminus. The Belt TOOL is not armed on this path
      // (a handle drag starts only with no tool armed: an armed tool makes the handles and,
      // since phase 89, an unselected belt's end tiles inert), so there is no resting set
      // underneath for this to wrongly take down.
      overlay.clearDockTargets();
      if (cand) {
        // Its claim (phase 88, plan 88-07, BELT-06, D-09): the source the link will take (the
        // dragged Head, or the target's Head, Out or Fault), until the Dock is answered, so a
        // second drag onto the same end before Play wears no accepting ring. The ring is a
        // prediction and never a gate (D-07): that second drop is still sent, and the host
        // answers it in words, `BeltEndTaken` or `PortOccupied`.
        sendInput(
          encodeGridCommand({
            kind: 'Dock',
            belt: drag.beltId,
            end: drag.end,
            node: cand.node,
            port: cand.port,
          }),
          {
            claim: dockClaim({
              belt: drag.beltId,
              end: drag.end,
              node: cand.node,
              port: cand.port,
              targetIsBelt: getScene().belts.has(cand.node),
            }),
          },
        );
      } else {
        // A RELEASE ON NOTHING. Nothing is emitted, because there is no port to
        // name and forging one would be the client inventing a target the user
        // never aimed at - and the flash goes over the cell the pointer was
        // actually released on, which is the only honest WHERE available. This
        // is the DrawWire release arm's own shape verbatim (see the
        // `wireArmed` branch above), reached from the other gesture.
        //
        // WHERE ONLY, AND NO REASON (D-10). The canvas says where the gesture
        // landed; the host says why, in words, through `#fab-refusal` - and here
        // the host was never asked, so there is no why to say. A reason invented
        // client-side would be the drift-C bug the arm above was rewritten to
        // remove.
        //
        // T-67-05-05 / WINDOWS row 113. 67-UI-SPEC 4.2's "Release, on nothing"
        // row specified this from the start; plan 67-05 reused this arm
        // byte-unchanged on the assumption the flash was already in it, and it
        // was not - all five shipped flash sites were Place or DrawWire. So the
        // gesture this phase added to RECOVER from a mistake answered a near-miss
        // with total silence, which is the exact symptom row 113 exists to track.
        // NARROWED 2026-08-30 to RING-SOURCED drags only, after phase-67's delta
        // re-verification measured a regression. This comment previously read
        // "It fires for EVERY belt-handle drag, not only a ring-sourced one: the
        // near-miss is identical in both" - and that reasoning is WRONG, because
        // the two callers do not mean the same thing by a release on nothing:
        //
        //   - From a STRANDED RING it is a near-miss on a recovery attempt. The
        //     user aimed at a port and missed. Saying nothing is the row-113
        //     silent-gesture symptom, so the flash is right.
        //   - From a SELECTED BELT's endpoint handle it is the DOCUMENTED CANCEL
        //     (`21-UI-SPEC.md:137`, `:206` - "No command; handle snaps back"), and
        //     until plan 89-07 it was that gesture's ONLY abort (Escape now cancels
        //     `handleDrag` too, D-11). Flashing a rejection there tells a user who
        //     deliberately backed out that they got something wrong.
        //
        // The whole 2012-case suite stayed green through the regression; it was
        // caught by a probe on `rejectFlashCalls`, which went from [] to one
        // entry. Pinned now by a case per provenance (6 and 6b) so it cannot
        // silently widen again.
        if (drag.fromRing) {
          const rp = toLocal(e);
          const cell = cam.screenToCell(rp.x, rp.y);
          overlay.showRejectFlash({ cx: cell.cx, cy: cell.cy }, { w: 1, h: 1, rot: 0 });
        }
      }
      // There is no second arm here any more. The PORT-08 "aimed squarely at a
      // wire port" case used to flash without emitting, which meant guessing the
      // reason client-side (drift C). `dropCandidate` is now set for ANY
      // reachable nub, so the arm above always fires when the pointer was over
      // one, and the host answers `MediumMismatch` in words (D-07, D-10).
      // Either way the belt stays selected; snap back / refresh the handles at
      // their CURRENT beltHandlePoints.
      reshowBeltHandles();
      return;
    }
    if (outDrag) {
      // The output-dot drag's release (phase 89, D-05, UI-SPEC 3.1). On a belt start: ONE Dock
      // of that belt's Tail onto this port, the frame and the claim a selected belt's Tail
      // handle dropped here sends, whether or not the ring predicted an accept (the host answers
      // a refusal in words, D-07). On nothing: the release cell flashes and nothing is sent. The
      // selection is not touched either way.
      const drag = outDrag;
      const belt = outDropBelt;
      endOutDrag();
      if (belt !== null) {
        sendInput(encodeGridCommand({ kind: 'Dock', belt, end: 'Tail', node: drag.node, port: drag.port }), {
          claim: dockClaim({ belt, end: 'Tail', node: drag.node, port: drag.port, targetIsBelt: false }),
        });
      } else {
        const rp = toLocal(e);
        const cell = cam.screenToCell(rp.x, rp.y);
        overlay.showRejectFlash({ cx: cell.cx, cy: cell.cy }, { w: 1, h: 1, rot: 0 });
      }
      return;
    }
    // A press on an output dot or an unselected belt's end tile released without leaving: the
    // click it was all along, the select below.
    outPress = null;
    endPress = null;
    if (!down) {
      return;
    }
    const start = down;
    down = null;
    cam.setPanEnabled(true);
    // Press-then-release selects. The node->node Wire gesture was removed in
    // Phase 17-02 (belts come only from the DrawBelt tool + Dock), so there is
    // no drag branch here — any press that began on a node/belt selects it.
    if (start.kind === 'node') {
      selection = { kind: 'node', id: start.id };
      overlay.clearBeltHandles();
      clearHandleHover();
      overlay.showSelection(start.id);
      deps.onSelect?.(start.id);
      // BELT-01: in the SAME breath. Selecting a node must clear any belt
      // selection, or `selectedNode` and `selectedBelt` are both non-null and the
      // app shows two config panels for two different things.
      deps.onSelectBelt?.(null);
    } else {
      // Belt selected (CTRL-01): endpoint grab handles, NO box outline. The
      // chrome selection stays node-scoped — selectedId() reads null and App
      // is notified with null so the machine delete control never sees a belt id
      // (a belt's Delete has its own guarded path, `requestBeltDelete`, phase 89).
      selection = { kind: 'belt', id: start.id };
      overlay.clearSelection();
      deps.onSelect?.(null);
      // BELT-01: the SECOND channel carries the belt handle. `onSelect` stays
      // null (see the `onSelectBelt` docblock: widening it would hand a belt the
      // machine's delete path), and this is the ONE site that fires a non-null belt.
      deps.onSelectBelt?.(start.id);
      reshowBeltHandles();
    }
  };

  // The SINGLE Delete emit path — used by the no-items keyboard branch AND every
  // dialog outcome (Delete anyway / drained-to-zero). Emitting one logged Delete
  // here for all paths is what makes "exactly one logged Delete per delete" hold
  // (SC5). The canvas removes the node only on the host echo (no optimistic write).
  const commitDelete = (handle: number): void => {
    // Its claim (review fix pass 1, WR-A-04): the node it removes, read by the cable preview
    // only, so a ghost cable drawn before Play goes where the landed one will.
    sendInput(encodeGridCommand({ kind: 'Delete', node: handle }), { claim: deleteClaim(handle) });
    overlay.clearSelection();
    if (selection?.kind === 'node' && selection.id === handle) {
      selection = null;
    }
    // A deleted BELT takes its selection and its end handles with it (phase 89, D-07, UI-SPEC
    // 2.3): otherwise the handles stay painted on a belt the host is removing.
    if (selection?.kind === 'belt' && selection.id === handle) {
      selection = null;
      overlay.clearBeltHandles();
      clearHandleHover();
    }
    deps.onSelect?.(null);
    deps.onSelectBelt?.(null);
  };

  // IX-04 (T-30-01): the SHARED delete-decision path. Runs the IDENTICAL guard as
  // the keyboard Delete branch — if the machine still carries in-flight items and
  // the UI guard is wired, defer to it (emit NOTHING here); otherwise a single
  // commitDelete. The keyboard Delete branch AND the DOM delete button (30-06)
  // both route through this ONE function, so there is no second decision path and
  // "exactly one logged Delete per delete" holds for every entry point (SC5).
  const requestDelete = (handle: number): void => {
    const { count, beltIds } = inFlightForNode(getScene(), handle);
    if (count > 0 && deps.onDeleteWithItems) {
      deps.onDeleteWithItems(handle, count, 'machine', beltIds);
      return;
    }
    commitDelete(handle);
  };

  // BELT-02 (phase 89, D-07): the belt's twin of `requestDelete`. The items counted are the
  // belt's OWN (a belt's Delete discards only what is on it, never its joined run, the host
  // contract since 74-12), and the belt is the one belt the guard's Drain first polls.
  const requestBeltDelete = (handle: number): void => {
    const count = getScene().belts.get(handle)?.items.length ?? 0;
    if (count > 0 && deps.onDeleteWithItems) {
      deps.onDeleteWithItems(handle, count, 'belt', [handle]);
      return;
    }
    commitDelete(handle);
  };

  // Selection clear on keyframe (WR-01 / UNDO-06). Called by App after a full:true
  // keyframe. An undo/redo/load rebuilds the host render-handle table from 0, so a
  // handle can be REUSED for a DIFFERENT node/belt — clearing only on ABSENCE (the
  // old reconcile) would leave a stale handle silently retargeted, so a later
  // Delete/Dock would hit the wrong element (T-21-08). Clear UNCONDITIONALLY and
  // clear EVERYTHING selection-scoped: node selection, belt selection, any
  // in-progress press, and every overlay affordance this layer drives. Selection
  // is frontend-ephemeral and never host-echoed, so this is cheap and correct.
  const clearSelection = (): void => {
    // The remembered rots die with the remint (plan 74.1-25): a reminted handle may name a
    // different node, and a keyframe's scene is the host's own answer anyway.
    pendingRots.clear();
    // A HELD BELT SURVIVES THE KEYFRAME (plan 88-06, D-06). Until then every held belt died
    // here, with its held picture and its predicted seam, because a reminted handle could
    // name a DIFFERENT element (T-21-13): an Undo's keyframe dropped every Dock still owed,
    // and the belt landed undocked with no message. Each held belt now ends on its own
    // verdict, and its Docks go out addressed to the generation their handles were read
    // in, for the host to resolve in that table or refuse with a sentence (plan 88-04).
    // A PENDING PLACE SURVIVES THE KEYFRAME (phase 88, D-06). Until phase 88 every
    // pending Place died here, because the client found its node by the cell and a
    // reminted handle could name a different node (T-21-16). Each entry now ends on its
    // own verdict, and an accepted one lands addressed to the handle and generation its
    // accept named: a keyframe of a higher generation makes it send at once, to the machine
    // on its anchor in that newest table (T-88-25), or end in silence when none is there.
    // Its shimmer stays with it.
    // WR-04: the port-to-port draw source is a node-handle-carrying pending
    // state — "No Dock may ever target a remint" applies to the recorded
    // {node, portIndex} exactly as it does to the follow-up entries above.
    //
    // A KEYFRAME MID-DRAW KEEPS THE PATH (phase 89, D-11, WINDOWS 246, research Pitfall 8). Until
    // plan 89-07 the drawn path died here with its start dock, so an Undo or a Load arriving while
    // the hand was down threw the user's draw away. The CELLS, the walk anchor and the pointer
    // hold no handle and survive; only the start dock (and the reversed draw's start In) names one,
    // and it is RE-RESOLVED at the end of this function against the new table, by the press's own
    // doorstep lookup on the first drawn cell, or dropped when nothing resolves there. A path with
    // no Belt tool behind it (none should exist) still dies as before.
    const keptPath = beltArmed && drawnCells !== null;
    const keptStart: 'source' | 'input' | null = startDock !== null ? 'source' : startIn !== null ? 'input' : null;
    startDock = null;
    startFeed = null;
    startIn = null;
    if (!keptPath) {
      beltPointer = null;
      if (drawnCells !== null) {
        drawnCells = null;
        drawnFrom = null;
        overlay.clearBeltPreview();
      }
    }
    // WIRE-02: the wire draw source is the SAME shape and dies the same way, and
    // for the same reason - it carries a dense render handle, and a keyframe
    // remint can point that handle at a different node. The armed Wire TOOL
    // survives (tool state, no handle captured); only the in-flight source dies.
    wireSource = null;
    // The armed Wire TOOL survives a keyframe, so the rings would be repainted by the
    // next armed move - but they are cleared HERE rather than left standing, because
    // between the remint and that move they name handles that no longer exist.
    overlay.clearRoute();
    overlay.clearWireTargets();
    // The belt tool's rings are cleared for the identical reason: the armed Belt TOOL
    // survives a keyframe, but between the remint and the next move its rings name
    // belt handles that no longer exist.
    overlay.clearDockTargets();
    if (rotatePress !== null) {
      rotatePress = null;
      cam.setPanEnabled(true);
    }
    clearRotateHover();
    if (down !== null) {
      down = null;
      cam.setPanEnabled(true);
    }
    if (handleDrag !== null) {
      // Mid-drag keyframe (T-21-08): kill the drag so a later move/up can
      // never emit a Dock against re-minted handles.
      handleDrag = null;
      cam.setPanEnabled(true);
      if (canvas.style.cursor === 'grabbing') {
        canvas.style.cursor = '';
      }
    }
    dropCandidate = null;
    // The output-dot drag and the end-tile press die the same way, for the same reason
    // (T-21-08): each carries a dense render handle a remint may point at something else.
    if (outDrag !== null || outPress !== null) {
      endOutDrag();
      cam.setPanEnabled(true);
    }
    endPress = null;
    clearHandleHover();
    nubHover = false;
    clearNubCursor();
    overlay.clearBeltHandles();
    overlay.clearDraggedHandle();
    overlay.clearNubRing();
    if (selection !== null) {
      selection = null;
      overlay.clearSelection();
      deps.onSelect?.(null);
      deps.onSelectBelt?.(null);
    }
    // THE KEPT PATH, RE-RESOLVED AND REPAINTED ON THIS FRAME (D-11, UI-SPEC section 5): the start
    // the press recorded is looked up again on the first drawn cell (the pressed doorstep) by the
    // same lookup the press used, so a doorstep that still names an Out, a Fault or a free belt
    // Head (a forward draw), or a free Mechanical In (a reversed draw), keeps its dock under its
    // NEW handle, and one that no longer does drops it: the draw goes on as a plain start. Then the
    // armed ring, the resting rings and the preview are painted again, so the preview never blinks
    // out, and the release sends every drawn cell.
    if (keptPath && drawnCells !== null) {
      const [sx, sy] = drawnCells[0];
      const seed = { cx: sx, cy: sy };
      if (keptStart === 'source') {
        const hit = doorstepPressHit(seed);
        if (hit) {
          startDock = { node: hit.handle, portIndex: hit.port.index };
          startFeed = hit.port.side;
          overlay.showNubRing({ x: hit.x, y: hit.y }, true);
        }
      } else if (keptStart === 'input') {
        const inHit = inDoorstepPressHit(seed);
        if (inHit) {
          startIn = { node: inHit.handle, port: inHit.port };
          overlay.showNubRing({ x: inHit.x, y: inHit.y }, true);
        }
      }
      paintDockTargets();
      refreshBeltPreview();
    }
  };

  // Selection refresh on echo (WR-01/WR-02): when a diff packet re-emits the
  // SELECTED element, re-derive its affordances from the post-apply scene.
  // Node (WR-01): a Rotate echo redraws the body in its new effective box
  // while the build-blue outline and the rotate-handle center stay pinned to
  // the old one until a reselect or a full keyframe — re-invoke showSelection
  // (the overlay resolves the handle against the live scene). Belt (WR-02): a
  // Dock echo moves an end's handle anchor from the tile center to the
  // resolved nub (~26.5px, beyond the 12px hit radius), so the drawn handle
  // would no longer be where `hitHandle` grabs — re-show at the CURRENT
  // beltHandlePoints. Display-only refresh in both cases.
  const refreshSelection = (
    placedNodeIds: readonly number[],
    emittedBeltIds: readonly number[],
  ): void => {
    // A re-emitted node that now SHOWS the rot its last sent Rotate was to produce has
    // echoed it: drop the record (plan 74.1-25), whether or not the node is selected.
    for (const id of placedNodeIds) {
      const pending = pendingRots.get(id);
      if (pending !== undefined && getScene().nodes.get(id)?.rot === pending.rot) {
        pendingRots.delete(id);
      }
    }
    if (selection?.kind === 'node' && placedNodeIds.includes(selection.id)) {
      overlay.showSelection(selection.id);
    } else if (
      selection?.kind === 'belt' &&
      emittedBeltIds.includes(selection.id)
    ) {
      reshowBeltHandles();
    }
  };

  const onKey = (e: KeyboardEvent): void => {
    // WR-01: while a modal (delete-guard dialog) owns the interaction, the gesture
    // layer consumes NO global shortcut. The dialog handles its own keys (Escape,
    // via capture). This closes the double-`Delete` path: a Delete pressed during
    // a drain can no longer re-enter the guard or start a second drain loop, so
    // "exactly one logged Delete per delete" holds (SC5).
    if (deps.isModalOpen?.()) {
      return;
    }
    // WR-03/IX-09: don't act on a shortcut meant for a focused chrome control.
    // The listener is window-level so it would otherwise consume `Space`/`.`/`r`/
    // `Delete` while a chrome BUTTON/SELECT/INPUT/TEXTAREA/contentEditable owns
    // focus. Keyboard-arming a palette button (IX-10, 30-05) makes a focused
    // BUTTON the common case, so BUTTON + SELECT are guarded below in addition to
    // the editable text targets — mirrors the App.tsx onHomeKey guard verbatim.
    // The Ctrl/Cmd accelerators (file and undo/redo) are the exception, handled
    // first: see the block after `isEditableTarget`.
    // Guarded for the no-DOM unit env (`document` undefined) so it stays a pure
    // no-op there.
    const active =
      typeof document !== 'undefined'
        ? (document.activeElement as HTMLElement | null)
        : null;
    // LW-02: whether focus is in a TEXT field (typing target). The accelerators
    // below are exempt from the BUTTON/SELECT focus guard but must still stand
    // down while the user is typing into a field.
    const isEditableTarget =
      !!active &&
      (active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.isContentEditable);
    // THE ACCELERATORS THAT PASS A FOCUSED BUTTON OR SELECT, and only these: the file
    // accelerators (LW-02: Ctrl/Cmd+S smart-Save, Ctrl/Cmd+Shift+S Save-As, Ctrl/Cmd+N
    // New, Ctrl/Cmd+O Open) and, since plan 74.1-20, undo and redo (UNDO-04: Ctrl/Cmd+Z
    // undo, Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y redo). Standard desktop accelerators fire
    // whatever button was last clicked or keyboard-focused: a button holds focus after a
    // click and after keyboard-arming a palette item (IX-10), and the BUTTON / SELECT
    // guard below used to drop undo there WITHOUT A WORD. On the 74.1 re-walk the user needed
    // two Ctrl+Z presses to undo a join (N3); the live leg that puts focus on a palette
    // button measured the first press dropped and the join kept.
    //
    // They are handled here, AFTER the modal guard (returned above) and only while no
    // TEXT field owns focus (isEditableTarget: INPUT, TEXTAREA, contentEditable), so a
    // Ctrl+Z typed into a field is the field's own undo and never reaches the board.
    // preventDefault stops the browser's own Save / New-window / Open / undo bindings.
    // Dispatch defers to App (deps.onUndo / onRedo), which emits the fieldless Undo /
    // Redo GridCommand on the GESTURE channel gated on availability, so the UI never
    // issues an undo or redo the session would reject.
    if (!isEditableTarget && (e.ctrlKey || e.metaKey)) {
      // FAIL-01 (D-12): on a stopped simulation Save, New, Open, Undo and Redo do nothing. The
      // browser's own binding is still prevented, so Ctrl+S never opens a page-save dialog.
      // The refused set is every Ctrl entry of the shortcut table (phase 91, D-11), so a new
      // accelerator is refused on a stopped board with no second edit here.
      if (simStopped() && CTRL_SHORTCUTS.some((s) => matchesShortcut(e, s))) {
        e.preventDefault();
        return;
      }
      // Every key below is tested through the one shortcut table (`shortcuts.ts`, phase 91
      // D-11), the table the Help panel and the toolbar titles read too.
      if (matchesShortcut(e, SHORTCUTS.save) || matchesShortcut(e, SHORTCUTS.saveAs)) {
        e.preventDefault();
        deps.onSave?.(matchesShortcut(e, SHORTCUTS.saveAs));
        return;
      }
      if (matchesShortcut(e, SHORTCUTS.newBoard)) {
        e.preventDefault();
        deps.onNew?.();
        return;
      }
      if (matchesShortcut(e, SHORTCUTS.open)) {
        e.preventDefault();
        deps.onOpen?.();
        return;
      }
      if (matchesShortcut(e, SHORTCUTS.undo) || matchesShortcut(e, SHORTCUTS.redo)) {
        e.preventDefault();
        if (matchesShortcut(e, SHORTCUTS.redo)) {
          deps.onRedo?.();
        } else {
          deps.onUndo?.();
        }
        return;
      }
      if (matchesShortcut(e, SHORTCUTS.redoY)) {
        e.preventDefault();
        deps.onRedo?.();
        return;
      }
    }
    // EVERY OTHER SHORTCUT stands down while a chrome control holds focus: a BUTTON or
    // SELECT as well as a text field. `Space`, `.`, `r`, `Delete` and `Escape` are the
    // focused control's own keys (Space presses a button, arrows move a select), so the
    // canvas must not act on them too. Only the accelerators above pass a button, and
    // Escape while a tool is armed or a drag is in flight (below).
    //
    // ESCAPE PASSES A FOCUSED BUTTON OR SELECT WHILE A TOOL IS ARMED (phase 89, D-11, WINDOWS
    // 252). Arming a palette tool from the keyboard (Tab to its row, Enter) leaves that row's
    // button focused, and the guard below then swallowed every Escape: the tool could not be put
    // away from the keyboard that armed it. A button has no Escape of its own, so while a tool is
    // armed, or an output-dot or handle drag is in flight, Escape is the board's. A TEXT field
    // still keeps it (`isEditableTarget`): Escape in the pace field is the field's.
    const boardOwnsEscape =
      matchesShortcut(e, SHORTCUTS.escape) &&
      !isEditableTarget &&
      (beltArmed ||
        wireArmed ||
        placementKind !== null ||
        outDrag !== null ||
        handleDrag !== null ||
        outPress !== null ||
        endPress !== null ||
        rotatePress !== null);
    // A FOCUSED SCROLL BOX KEEPS ITS KEYS TOO (review WR-B-05): the Help list's box, while it
    // scrolls and has focus, scrolls on Space and the arrows; the board taking Space there toggled
    // play instead. Its attribute is `HelpPanel.tsx`'s `HELP_SCROLL_ATTR`.
    if (
      !boardOwnsEscape &&
      active &&
      (active.tagName === 'BUTTON' ||
        active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.tagName === 'SELECT' ||
        active.isContentEditable ||
        active.hasAttribute('data-fab-help-scroll'))
    ) {
      return;
    }
    if (matchesShortcut(e, SHORTCUTS.escape)) {
      // AN OUTPUT-DOT DRAG IN FLIGHT IS CANCELLED FIRST (UI-SPEC A14, D-11): nothing sent, every
      // mark cleared, and nothing else this press would have done (no tool can be armed under
      // it, and the selection it never touched stays).
      if (outDrag !== null) {
        endOutDrag();
        return;
      }
      // A BELT-HANDLE OR RING DRAG IN FLIGHT IS CANCELLED THE SAME WAY (plan 89-07, the 89-06
      // carry-over): until 89-07 Escape did not touch `handleDrag`, so it cleared the belt
      // selection under a drag that still docked on its release. Nothing sent; a selected belt's
      // handles snap back and the selection stays. And THE SAME GESTURES BEFORE THEIR DRAG
      // THRESHOLD (review WR-B-05): an output-dot press, an unselected belt's end-tile press and
      // a rotate-handle press. Until then Escape fell through to clearing the selection, the
      // still-held pointer then left the dot or tile, and the drag that began docked on release.
      if (handleDrag !== null || outPress !== null || endPress !== null || rotatePress !== null) {
        cancelIdleGesture();
        return;
      }
      // ESCAPE CANCELS THE PATH FIRST (D-11, WINDOWS 247): the first Escape with a belt path in
      // progress (or a wire source held) ends it and keeps the tool; the release that follows
      // finds no path and sends nothing; the next Escape puts the tool away below.
      if (beltArmed && drawnCells !== null) {
        dropBeltPath();
        return;
      }
      if (wireArmed && wireSource !== null) {
        cancelWireSource();
        return;
      }
      // IX-07 disarm-before-clear ordering: with no path or source in progress (the rung
      // above), an armed tool disarms and a selection is NOT also cleared in the same
      // press. Only when nothing was armed does Escape fall through to clearing a selection.
      let disarmed = false;
      // Esc cancels the armed Belt tool (restores pan + cursor + armed report).
      if (beltArmed) {
        disarmBelt();
        disarmed = true;
      }
      // Esc cancels the armed Wire tool on the same terms (WIRE-02).
      if (wireArmed) {
        disarmWire();
        disarmed = true;
      }
      // WR-08/IX-03: Esc disarms an armed placement too, through the shared
      // disarmPlacement teardown (ghost cleared, pan + cursor restored,
      // onArmedChange(null)). No command was ever emitted for the arm.
      if (placementKind !== null) {
        disarmPlacement();
        disarmed = true;
      }
      // IX-07: with nothing armed, Escape clears an active node/belt selection
      // via the shared selection teardown (mirrors the keyframe clearSelection
      // path — overlay clears + clearHandleHover + onSelect(null)). Frontend-
      // ephemeral, never host-echoed, so this is cheap and emits no command.
      let cleared = false;
      if (!disarmed && selection !== null) {
        selection = null;
        overlay.clearSelection();
        overlay.clearBeltHandles();
        clearHandleHover();
        deps.onSelect?.(null);
        deps.onSelectBelt?.(null);
        cleared = true;
      }
      // ONB-01 lowest-priority fallback: ONLY when Escape was otherwise a no-op
      // (nothing disarmed, nothing cleared) does it dismiss the first-run welcome
      // card. This keeps IX-07 winning: Escape does the most-immediate escapable
      // thing first, and closes the onboarding card only when there is nothing
      // else to escape. App gates the actual dismiss on the card being shown.
      if (!disarmed && !cleared) {
        deps.onEscapeFallback?.();
      }
      return;
    }
    // FAIL-01 (D-12): on a stopped simulation Space, `.`, R, Delete and Backspace do nothing
    // (Escape, above, still runs). Space is still kept from scrolling the page.
    if (simStopped()) {
      if (matchesShortcut(e, SHORTCUTS.playPause)) e.preventDefault();
      return;
    }
    if (matchesShortcut(e, SHORTCUTS.playPause)) {
      e.preventDefault();
      deps.onTogglePlay?.();
    } else if (matchesShortcut(e, SHORTCUTS.step)) {
      deps.onStep?.();
    } else if (matchesShortcut(e, SHORTCUTS.rotate) || matchesShortcut(e, SHORTCUTS.rotateBack)) {
      // Factorio rotate: 'r' = CW, 'Shift+R' = CCW. While a placement is armed,
      // rotate the GHOST (CTRL-03 / D-14): cycle placementRot and re-preview the
      // rotated effective box + port nubs at the cursor. `Place` still carries
      // no rotation — the rot lands as N echo-gated Rotates at commit (Finding
      // 4). Otherwise rotate the SELECTED machine via exactly ONE logged Rotate
      // — the canvas turns only on the host echo (SC5, no optimistic write).
      e.preventDefault();
      // Phase 76 (D-04): A LABEL NEVER TURNS. R with the Label tool armed leaves the
      // ghost at rot 0 and queues nothing, and R with a label selected sends nothing:
      // the host would refuse a Rotate naming a label as WrongKind anyway (Malformed until 88-02).
      if (placementKind === machine_kind.LABEL) {
        return;
      }
      const back = matchesShortcut(e, SHORTCUTS.rotateBack);
      if (placementKind !== null) {
        placementRot = back
          ? (placementRot + 3) & 3
          : (placementRot + 1) & 3;
        ghost.setPlacement(placementKind, placementRot);
        if (lastMovePoint?.overCanvas) {
          ghost.moveTo(lastMovePoint.x, lastMovePoint.y);
        }
        return;
      }
      // NODE selections only — a selected belt makes 'r' a no-op this phase.
      const rotTarget = selectedNode();
      if (rotTarget !== null && getScene().nodes.get(rotTarget)?.kind !== machine_kind.LABEL) {
        // THE WHERE of a turn the host will refuse because a belt is in the way (plan
        // 74.1-18, review WR-03, the maintainers' "Refuse, say why"), through the one send the
        // rotate handle uses too (plan 74.1-25, review WR-04).
        sendRotate(rotTarget, back);
      }
    } else if (matchesShortcut(e, SHORTCUTS.delete)) {
      // A selected NODE or, since phase 89 (D-07, UI-SPEC 2.2), a selected BELT. Both sit
      // behind the modal and focused-field guards above, so a Backspace typed in the pace
      // field edits the text and sends nothing.
      const delTarget = selectedNode();
      if (delTarget !== null) {
        // IX-04 (T-30-01): route through the SHARED requestDelete path so the
        // keyboard Delete and the DOM delete button (30-06) run the IDENTICAL
        // REND-03 in-flight-items guard — defer to the UI guard when items are in
        // flight (emit NOTHING here), else exactly one commitDelete. No second
        // decision path; SC5's "one logged Delete per delete" holds.
        requestDelete(delTarget);
      } else if (selection?.kind === 'belt') {
        // The belt's own guarded path, the one its panel's `Delete belt` button takes too.
        requestBeltDelete(selection.id);
      }
    }
  };

  // IX-08: suppress the native context menu on the CANVAS ONLY (never global) so
  // a right-click cancel gesture can't pop the OS/browser menu over the grid.
  // Torn down in destroy() — no listener leak, no global suppression. (Firefox
  // Shift+right-click bypasses the contextmenu event entirely; that is a
  // documented acceptable edge, not a cancel gesture.)
  const onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  canvas.addEventListener('pointerdown', onCanvasDown);
  canvas.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('pointermove', onWinMove);
  window.addEventListener('pointerup', onWinUp);
  window.addEventListener('keydown', onKey);
  // The interruptions (plan 89-07, D-11): a cancelled pointer, the owner's lost capture, and the
  // window losing focus mid-gesture. Removed in destroy() with the rest.
  window.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('lostpointercapture', onLostCapture);
  window.addEventListener('blur', onBlur);

  return {
    beginPlacement,
    onVerdict,
    onResume,
    onSwap,
    waiting: () => ({ placements: pendingPlacements.length, belts: beltFollowUps.length, docks: dockOwners.size }),
    beginRouterPreset,
    armBeltDraw,
    armWireDraw,
    selectedId: selectedNode,
    commitDelete,
    requestDelete,
    requestBeltDelete,
    clearSelection,
    refreshSelection,
    setStrandedRings,
    standDown,
    destroy: (): void => {
      canvas.removeEventListener('pointerdown', onCanvasDown);
      canvas.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('pointermove', onWinMove);
      window.removeEventListener('pointerup', onWinUp);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('lostpointercapture', onLostCapture);
      window.removeEventListener('blur', onBlur);
      if (echoRaf) {
        cancelAnimationFrame(echoRaf);
      }
      endEveryBeltFollowUp();
      setPendingSeamsPlayState(null);
      pendingPlacements = [];
      shimmerOwner = null;
      rotatePress = null;
      outPress = null;
      outDrag = null;
      outDropBelt = null;
      endPress = null;
      strandedRings = [];
      strandedHover = false;
      cam.setPanEnabled(true);
      canvas.style.cursor = '';
      overlay.clearGhost();
      overlay.clearRoute();
      overlay.clearWireTargets();
      overlay.clearDockTargets();
      overlay.clearBeltPreview();
      overlay.clearSelection();
      overlay.clearHover();
      overlay.clearBeltHandles();
      overlay.clearHandleRing();
      overlay.clearDraggedHandle();
      overlay.clearNubRing();
      overlay.clearPending();
    },
  };
}
