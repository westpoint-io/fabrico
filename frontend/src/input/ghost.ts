// ghost.ts - the placement ghost affordance controller (VIS-05, authoritative): the ghost
// that follows the pointer once a palette click arms a machine, until a floor click places it.
//
// This is the "build ghost" half of the interaction layer: it snaps a translucent
// machine ghost to the hovered cell and computes drop-validity from the CURRENT
// echoed scene. It DRIVES 07-07's overlay primitive (`showGhost(cell, valid)`) and
// NEVER mutates the grid - validity is read-only off the sceneState the sim echoes,
// and a placement only ever becomes real when the host echoes it back (SC5).
//
// Critically, this plan never statically imports 07-07's `overlay.ts`: it declares
// the structural `OverlayAffordances` interface that `handle.overlay` satisfies and
// receives the overlay handle as a parameter (from App.tsx). build-blue = valid,
// red-pink = invalid. Amber is never used here (reserved for live items).

import type { CellCoord, Camera } from '../render/camera';
import type { SceneState } from '../render/sceneState';
import type { CableNubs } from '../render/cableGeometry';
import type { NodeView, TileView } from '../protocol/decode';
import { catalogEntry } from '../protocol/decode';
import { cellsOfFootprint } from '../protocol/footprint';
import { rotateCatalogPort } from '../protocol/ports';

/**
 * The structural subset of 07-07's exported overlay handle this plan DRIVES.
 * `handle.overlay` (OverlayApi) satisfies this; declaring it locally keeps the
 * interaction layer decoupled from `overlay.ts` (no static import - App.tsx wires
 * the concrete handle in).
 */
export interface OverlayAffordances {
  /**
   * Translucent build ghost snapped to a cell: build-blue if valid, red if not.
   * `dims` (rot-0 `w`/`h` + `rot`) draws the real MULTI-CELL footprint silhouette
   * (effective-box on odd rot); absent/1x1 keeps the single-cell body. `ports`
   * (rotated catalog ports, ghost-local `lx`/`ly` cell offsets + side + role)
   * draws role-colored preview nubs on the ghost.
   */
  showGhost(
    cell: CellCoord,
    valid: boolean,
    dims?: { w: number; h: number; rot: number },
    ports?: Array<{ lx: number; ly: number; side: number; role: number }>,
  ): void;
  clearGhost(): void;
  /**
   * Orthogonal/Manhattan wire-route preview through a path of cells. `nubs` are the
   * corridor's two ends, REQUIRED (plan 75-05, D-08): the pressed port's nub and the
   * acquired port's nub, or `NO_NUB` for the free end, placed by the same `cablePoints`
   * builder the landed cable uses. `lane` is D1's lane key for the same route, so the
   * ghost sits in the lane the landed cable will take (66-UI-SPEC 5.1). Defaults to 0.
   *
   * `pairedLegs` are the OTHER legs the SAME gesture will mint (D-04, plan 72-11): one
   * `DrawWire` between a Route and a Handler lands two cables, so the drag shows two
   * corridors. They are passed in one call because `showRoute` clears first, and they
   * carry no colour or direction of their own - the single `valid` flag colours the
   * whole pairing.
   */
  showRoute(
    path: CellCoord[],
    nubs: CableNubs,
    valid?: boolean,
    lane?: number,
    pairedLegs?: ReadonlyArray<{ path: CellCoord[]; lane: number; nubs: CableNubs }>,
  ): void;
  clearRoute(): void;
  /**
   * Live draw-belt preview: the routed `tiles` (from the golden-pinned `route()`)
   * drawn build-blue when `valid`, red when not - reuses the 14-05 tile-path
   * primitive so the preview and the committed belt share ONE corner algorithm.
   */
  showBeltPreview(tiles: TileView[], valid: boolean): void;
  clearBeltPreview(): void;
  /**
   * The held pictures of committed belts the host has not drawn yet (plan 74.1-30), one
   * tile list per belt, on a surface of their own so a new drag never erases them. Each
   * call replaces the whole set.
   */
  showHeldBelts(pictures: ReadonlyArray<readonly TileView[]>): void;
  clearHeldBelts(): void;
  /**
   * Solid build-blue selection outline + corner ticks spanning the node's full
   * EFFECTIVE box (REND-05), plus the rotate handle at its top-right corner.
   */
  showSelection(id: number): void;
  clearSelection(): void;
  /** Soft hover ring on the cell under the cursor. */
  hoverRing(cell: CellCoord): void;
  clearHover(): void;
  /**
   * Belt-end grab handles at the GIVEN world points - positions are computed
   * by gestures via `ports.beltHandlePoints`; the overlay stays dumb (CTRL-01).
   */
  showBeltHandles(head: { x: number; y: number }, tail: { x: number; y: number }): void;
  clearBeltHandles(): void;
  /**
   * Handle hover ring (UI-SPEC section 3 hover row): r=8 stroke 1.5px hoverRing
   * on a selected belt's endpoint handle under the cursor (CTRL-01).
   */
  showHandleRing(pt: { x: number; y: number }): void;
  clearHandleRing(): void;
  /** The dragged belt-end handle following the cursor (alpha 0.9). */
  showDraggedHandle(pt: { x: number; y: number }): void;
  clearDraggedHandle(): void;
  /** Nub ring: passive hover (hoverRing) or armed drop target (build) - CTRL-02. */
  showNubRing(pt: { x: number; y: number }, armed: boolean): void;
  clearNubRing(): void;
  /**
   * The RESTING wire affordance (WIRE-05, UI-SPEC 6.2, plan 66-06): a build-blue ring
   * on EVERY nub the armed Wire tool can reach, painted BEFORE any press, plus a
   * filled disc on the one nub a press has grabbed.
   *
   * Declared HERE, on the structural handle, for the reason the file head gives: the
   * gesture layer drives the overlay and never imports it, so a new affordance is a
   * new row on this interface rather than a static import. App.tsx wires the concrete
   * `OverlayApi` in and it satisfies this by shape.
   */
  showWireTargets(pts: Array<{ x: number; y: number; filled: boolean }>): void;
  clearWireTargets(): void;
  /**
   * The RESTING belt-dock affordance (LINK-02 / LINK-10, 74-UI-SPEC 1.2 and 3.1): the
   * SAME ring, on its own Graphics, driven by the armed BELT tool and by a belt end
   * handle drag in flight. Declared here for the same structural reason as the row
   * above; D-07 is the paint condition, so it appears with the arm and disappears with
   * the disarm and never paints at rest.
   */
  showDockTargets(pts: Array<{ x: number; y: number; filled: boolean }>): void;
  clearDockTargets(): void;
  /** Rotate-handle center in world px, or null when no node is selected (CTRL-03). */
  rotateHandleCenter(): { x: number; y: number } | null;
  /** Hover styling for the rotate handle. */
  setRotateHandleHover(on: boolean): void;
  /**
   * IX-05 honest feedback (30-01): the NEUTRAL "placing" shimmer at the placed
   * cell while awaiting the host echo - replaces the dishonest optimistic
   * build-blue persist. `dims` are the rot-0 footprint + rot (the overlay
   * applies effectiveBox). Cleared on the echo or the silent TTL.
   */
  showPending(
    cell: CellCoord,
    dims: { w: number; h: number; rot: number },
  ): void;
  clearPending(): void;
  /**
   * IX-05 honest feedback (30-01): a one-shot fault flash over the attempted
   * footprint box on an illegal-cell click. Self-clears via the tick heartbeat.
   */
  showRejectFlash(
    cell: CellCoord,
    dims: { w: number; h: number; rot: number },
  ): void;
  /**
   * Are the stranded-dock alert rings CURRENTLY painted? (CONNECT-02.)
   *
   * A pure read of the overlay's own ring lifetime (`showAlertRings` stamps it,
   * `clearAlertRings` nulls it - and since 2026-08-30 those are the only two
   * writers, because the ring persists until the strand is RESOLVED rather than
   * expiring on a clock). The stranded-ring PRESS test gates on this so the
   * pressable set is exactly the painted set: without it a cleared, invisible
   * ring would stay grabbable and a click near a belt end would silently start a
   * dock drag. Declared HERE,
   * on the structural handle, for the reason the file head gives - the gesture
   * layer drives the overlay and never imports it.
   */
  alertRingsActive(): boolean;
  /**
   * Retire the stranded-dock alert ring at ONE point, keeping the rest
   * (CONNECT-02). The gesture layer calls this on a ring PRESS: that ring has
   * said its piece and `showDraggedHandle` takes over the point, while any
   * other stranded ring on the board stays unanswered and stays painted.
   *
   * Returns whether a ring was actually found at `pt` (67-REVIEW WR-03). A `false`
   * means the painted set and the pressable set have drifted apart, and the caller
   * has to reconcile rather than assume the retire landed.
   */
  clearAlertRingAt(pt: { x: number; y: number }): boolean;
}

/**
 * Read-only occupancy probe: the node whose FOOTPRINT contains `(cx, cy)` in the
 * echoed scene, or undefined. Pure read - this is how the gesture layer computes
 * placement validity and detects the placement echo WITHOUT a local write.
 *
 * Footprint-aware (RESEARCH Pitfall 1): a multi-cell machine (e.g. a 2x3 ROUTER)
 * is selected when ANY of its body cells is clicked, not only its anchor. Each
 * node's occupied cells come from the SHARED `cellsOfFootprint` mirror, so
 * selection / wire-targeting / ghost-validity / draw-belt collision all agree
 * with the core expansion - no scattered rectangle math (Don't-Hand-Roll).
 *
 * A correct linear membership test is used here; node counts are small. If
 * profiling shows this hot, build a `cell-key -> handle` index per scene-state
 * read (the cell→handle index option) instead - the shape stays the same.
 */
export function nodeAtCell(
  scene: SceneState,
  cx: number,
  cy: number,
): NodeView | undefined {
  for (const node of scene.nodes.values()) {
    const cells = cellsOfFootprint(
      node.cell_x,
      node.cell_y,
      node.w,
      node.h,
      node.rot,
    );
    for (const [fx, fy] of cells) {
      if (fx === cx && fy === cy) {
        return node;
      }
    }
  }
  return undefined;
}

/**
 * The ONE frontend occupancy definition (D-24). A cell is occupied when a machine
 * FOOTPRINT covers it (via `nodeAtCell`) OR an existing belt routes a tile through
 * it. Both halves are required: the host's occupancy index counts every belt tile,
 * so a node-only predicate disagrees with the authority it is predicting.
 *
 * Pure read off the echoed scene. Every frontend surface that asks "is this cell
 * taken?" - the placement ghost and the draw-belt path preview - consults THIS
 * function, so a prediction can never be split across two definitions. The host
 * `validate_normalize` remains the sole judge (SC5-tolerant); this only keeps the
 * client's expectation honest.
 *
 * It lives here rather than in `gestures.ts` because the import direction runs
 * `gestures.ts` -> `ghost.ts`; exporting it upward would make a module cycle.
 *
 * THE QUEUED GESTURES ARE PART OF THE ONE DEFINITION (phase 88, plan 88-07, BELT-06, D-09). A
 * gesture sent but not yet folded (a pending Place's footprint, a held belt's tiles, a queued
 * label grow's new cells) takes its cells as surely as the scene's nodes and belts do, and on
 * a paused board it waits until Play: the host would refuse a second gesture over them then.
 * So a cell `scene.queuedClaims` occupies reads as occupied, with the same `exclude` rule (a
 * label's own resize claim does not count against its outline), and every reader above - the
 * ghost, the belt path check, the doorstep rings, the label resize outline - refuses before
 * Play what the host would refuse on Play. A queued Delete claims nothing: its node still
 * reads as occupied until the Delete folds (research Finding F).
 */
export function cellOccupied(
  scene: SceneState,
  cx: number,
  cy: number,
  // Plan 76-03: a node whose OWN cells do not count (the label being resized). Absent for
  // every shipped caller, which is byte-for-byte the old answer.
  exclude?: number,
): boolean {
  const owner = nodeAtCell(scene, cx, cy);
  if (owner !== undefined && owner.id !== exclude) {
    return true;
  }
  for (const belt of scene.belts.values()) {
    for (const t of belt.tiles) {
      if (t.cell_x === cx && t.cell_y === cy) {
        return true;
      }
    }
  }
  return scene.queuedClaims?.occupies(cx, cy, scene.generation, exclude) ?? false;
}

/**
 * The grid's inclusive cell bounds on both axes, the TypeScript mirror of
 * `fabrico_core::state::GRID_MIN` / `GRID_MAX` (phase 76, plan 76-03).
 *
 * LOCKED, NOT MERELY COPIED: `crates/fabrico-command/tests/ts_label_mirror.rs`
 * `the_grid_bound_the_prediction_reads_is_the_engines` extracts both literals by anchor,
 * asserts they equal the Rust constants, and panics on a missing anchor. Until this plan
 * the frontend kept no copy (`protocol/addOutput.ts` records the gap); the label's
 * pending-size outline must turn `fault` for a growth past the edge, which the host
 * refuses as `OutOfBounds`, so the one prediction below reads them.
 */
export const GRID_MIN = -512;
export const GRID_MAX = 512;

/**
 * The most tiles one belt may have, the TypeScript mirror of `fabrico_core::edit::MAX_BELT_TILES`
 * (phase 89, plan 89-09, D-12, WINDOWS 251). The host refuses a longer DrawBelt as `BeltTooLong`
 * (`command.rs`, after the route and before any tile's bounds or occupancy), so the belt preview
 * reads it: a path of more tiles previews red, and its release sends at most one tile more than
 * this, enough for the host to answer `BeltTooLong` while the frame stays far under the gesture
 * frame cap (`transport_ws.rs` `MAX_GESTURE_FRAME`, research A4).
 *
 * LOCKED, NOT MERELY COPIED: `crates/fabrico-command/tests/ts_label_mirror.rs`
 * `the_belt_length_cap_the_preview_reads_is_the_engines` extracts the literal by anchor, asserts it
 * equals the Rust constant and panics on a missing anchor, and
 * `the_belt_length_cap_is_declared_in_one_place` asserts this is the only frontend declaration.
 */
export const MAX_BELT_TILES = 1024;

/**
 * THE ONE CLIENT PREDICTION of "would the host let this footprint stand here" (phase 76,
 * plan 76-03; D-24's occupancy definition, now with the grid edge). True when EVERY cell
 * of the `w` by `h` box at `anchor` turned by `rot` lies inside {@link GRID_MIN}..
 * {@link GRID_MAX} and is not occupied: no node's footprint covers it (other than the node
 * `exclude` names) and no belt routes a tile through it.
 *
 * Two callers, one definition: the placement ghost asks it with NO exclusion (a new
 * machine collides with everything), and the label's pending-size outline asks it with
 * the label's own id excluded, because growing or shrinking a label never collides with
 * the cells it already holds (the host's Configure arm excludes them the same way).
 * A courtesy, never a verdict: the host's validate arm decides.
 */
export function footprintFits(
  scene: SceneState,
  anchor: CellCoord,
  dims: PlacementDims,
  exclude?: number,
): boolean {
  for (const [fx, fy] of cellsOfFootprint(anchor.cx, anchor.cy, dims.w, dims.h, dims.rot)) {
    if (fx < GRID_MIN || fx > GRID_MAX || fy < GRID_MIN || fy > GRID_MAX) {
      return false;
    }
    if (cellOccupied(scene, fx, fy, exclude)) {
      return false;
    }
  }
  return true;
}

export interface GhostDeps {
  overlay: OverlayAffordances;
  cam: Camera;
  getScene: () => SceneState;
}

/**
 * The footprint a placement would occupy at its anchor: rot-0 dims `(w, h)` plus
 * the orientation `rot`. Threading this into the controller is what makes a
 * multi-cell drop's validity check ALL its target cells, not just the anchor.
 */
export interface PlacementDims {
  w: number;
  h: number;
  rot: number;
}

export interface GhostController {
  /** Snap the ghost to the cell under a canvas-relative point; returns validity. */
  moveTo(screenX: number, screenY: number): { cell: CellCoord; valid: boolean };
  /** Re-show the ghost at an explicit cell (used to PERSIST it pending the echo). */
  show(cell: CellCoord, valid: boolean): void;
  /**
   * Is `cell` a legal drop target? A placement is valid only when EVERY cell of
   * its footprint is unoccupied in the echoed scene. `dims` defaults to the
   * controller's current placement context (set via `setPlacement`), and to 1x1
   * rot0 when none is set - so existing single-cell callers are unaffected.
   */
  validAt(cell: CellCoord, dims?: PlacementDims): boolean;
  /**
   * Set the active placement footprint from a machine kind + rotation. The ghost
   * derives its dims from the core-authoritative catalog (`catalogEntry(kind)`,
   * the single source that replaced the hand-maintained per-kind dims table) so
   * subsequent `moveTo`/`validAt` size the drop correctly. Pass `null` to clear
   * (back to the 1x1 default).
   */
  setPlacement(kind: number | null, rot?: number): void;
  /** The current ghost cell, or null when cleared. */
  current(): CellCoord | null;
  /**
   * HIDE the ghost without disarming it: drops the current cell and wipes the
   * overlay, but KEEPS the active `placement` footprint and its port preview.
   * This is what the cursor leaving the canvas means - the tool is still in
   * hand, it just has nowhere to draw. Re-entering the canvas resumes the
   * correct multi-cell ghost with no re-arm.
   *
   * Distinct from `clear()` on purpose: `clear()` used to do both jobs, so a
   * cursor merely passing over the palette destroyed the armed footprint. The
   * ghost then fell back to the 1x1 default and painted valid-blue over ground
   * a 2x3 body could not fit - an invitation the host refused.
   */
  hide(): void;
  /**
   * DISARM: hide the ghost AND drop the placement footprint (back to the 1x1
   * default). Only for the paths where the tool genuinely leaves the hand -
   * Esc / right-click / re-click (`disarmPlacement`) and a tool switch
   * (`armBeltDraw`). Never for a mere off-canvas move; use `hide()` there.
   */
  clear(): void;
}

/**
 * Create the ghost controller. It owns NO state beyond the current target cell;
 * validity is recomputed from the live sceneState every move so it always tracks
 * what the sim has actually echoed (never an optimistic local placement).
 */
export function createGhostController(deps: GhostDeps): GhostController {
  const { overlay, cam, getScene } = deps;
  let cur: CellCoord | null = null;
  // The active placement footprint (null => 1x1 rot0). Read-only context for
  // validity; never a local grid write (SC5 - the host echo stays authoritative).
  let placement: PlacementDims | null = null;
  // The rotated catalog port preview for the active placement (null when no
  // kind is armed or the kind is portless). Computed ONCE per setPlacement via
  // `rotateCatalogPort` - the TS mirror of the core `port_world` closed form
  // and the ONLY legal local rotation: the ghost has no anchor for the host to
  // resolve ports against, so this mirror previews what `Place` + N `Rotate`
  // will land. PLACED nodes always use host-resolved `ports[]` (CTRL-03).
  let placementPorts: Array<{
    lx: number;
    ly: number;
    side: number;
    role: number;
    medium: number;
  }> | null = null;

  // A placement is valid only when EVERY cell of its footprint is unoccupied in
  // the echoed scene. The shared `cellsOfFootprint` expansion guarantees this
  // agrees cell-for-cell with how the sim claims the same footprint.
  //
  // Occupancy is `cellOccupied`, NOT `nodeAtCell`: the host's occupancy index
  // counts every belt tile as well as every node footprint cell, so a node-only
  // predicate had the ghost promising a placement the host would refuse - it
  // painted valid-blue over a belt and the click did nothing at all. The ghost
  // predicts the host's answer, so it must ask the host's question.
  //
  // Since plan 76-03 the walk is `footprintFits`, the ONE prediction the label's
  // pending-size outline also asks (with its own id excluded; the ghost excludes
  // nothing), and it adds the grid edge the host answers `OutOfBounds` at.
  const validAt = (cell: CellCoord, dims?: PlacementDims): boolean =>
    footprintFits(getScene(), cell, dims ?? placement ?? { w: 1, h: 1, rot: 0 });

  const setPlacement = (kind: number | null, rot = 0): void => {
    // Size the ghost from the core-authoritative catalog (CAT-05) - the single
    // source of footprint geometry, mirroring `port_catalog`. The former
    // hand-maintained per-kind dims table is gone (CLEAN-05).
    if (kind === null) {
      placement = null;
      placementPorts = null;
      return;
    }
    const entry = catalogEntry(kind);
    const { w, h } = entry;
    placement = { w, h, rot };
    // Rotated catalog port preview: each rot-0 catalog port mapped through the
    // `port_world` closed-form mirror into ghost-local `{lx, ly, side}` specs
    // (role and medium carried through, so the overlay draws each nub with the
    // canvas's own `drawRoleNub`: role shape and an electrical square). rot 0 passes
    // the catalog ports unchanged; a portless kind previews nothing.
    placementPorts = entry.ports.map((p) => ({
      ...rotateCatalogPort(p, w, h, rot),
      role: p.role,
      medium: p.medium,
    }));
  };

  const show = (cell: CellCoord, valid: boolean): void => {
    // Pass the active footprint so the overlay draws the real multi-cell
    // silhouette (1x1 placements render byte-identically to before), plus the
    // rotated catalog port preview so the ghost shows the exact ports the
    // Place + N Rotate commit sequence will produce (CTRL-03 / D-14).
    overlay.showGhost(cell, valid, placement ?? undefined, placementPorts ?? undefined);
    cur = cell;
  };

  const moveTo = (screenX: number, screenY: number) => {
    const cell = cam.screenToCell(screenX, screenY);
    const valid = validAt(cell);
    show(cell, valid);
    return { cell, valid };
  };

  return {
    moveTo,
    show,
    validAt,
    setPlacement,
    current: (): CellCoord | null => cur,
    // The VISUAL half alone. `placement`/`placementPorts` deliberately survive:
    // the tool is still armed, the cursor is just off the grid.
    hide: (): void => {
      cur = null;
      overlay.clearGhost();
    },
    // Hide AND disarm - the tool leaves the hand.
    clear: (): void => {
      cur = null;
      placement = null;
      placementPorts = null;
      overlay.clearGhost();
    },
  };
}
