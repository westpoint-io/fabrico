import { describe, expect, it } from "vitest";
import type { BeltView, NodeView } from "../protocol/decode.ts";
import { createSceneState, type SceneState } from "../render/sceneState.ts";
import { machine_kind } from "../protocol/kinds.ts";
import {
  GRID_MAX,
  GRID_MIN,
  cellOccupied,
  createGhostController,
  footprintFits,
  nodeAtCell,
} from "./ghost.ts";
import type { GhostController } from "./ghost.ts";
import { beltClaim, createQueuedClaims, resizeClaim } from "./queuedClaims.ts";

// ghost.ts is the footprint-aware hit-test + placement-validity probe (RESEARCH
// Pitfall 1). These tests pin the multi-cell behaviour: selection on ANY body
// cell of a 2x3 ROUTER, and a placement valid only when EVERY target cell is free.

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

const sceneWith = (...nodes: NodeView[]): SceneState => {
  const scene = createSceneState();
  for (const n of nodes) {
    scene.nodes.set(n.id, n);
  }
  return scene;
};

// A DrawBelt-drawn belt, the shape the decoded packet carries: a handle plus one
// TileView per drawn cell. The demo scene's belt 10 is `DrawBelt(cells: [(7,3),
// (8,3)])`, so the fixtures below use that literal path - the cell the phase's
// tracer arms a Source over.
const belt = (id: number, cells: [number, number][]): BeltView => ({
  id,
  latency: cells.length,
  fill: 0,
  items: [],
  tiles: cells.map(([cell_x, cell_y]) => ({
    cell_x,
    cell_y,
    kind: { Straight: { axis: 0 } },
  })),
  docks: [],
  ticks_per_slot: 1,
});

const withBelts = (scene: SceneState, ...belts: BeltView[]): SceneState => {
  for (const b of belts) {
    scene.belts.set(b.id, b);
  }
  return scene;
};

// A 2x3 ROUTER anchored at (2,2) occupies cells (2,2),(3,2),(2,3),(3,3),(2,4),(3,4).
const router2x3 = node({
  id: 42,
  kind: machine_kind.ROUTER,
  cell_x: 2,
  cell_y: 2,
  w: 2,
  h: 3,
  rot: 0,
});

// A controller with a stubbed overlay + camera; only validAt/setPlacement are
// exercised here (validity is a pure read off the scene).
const controllerOn = (scene: SceneState): GhostController =>
  createGhostController({
    overlay: {
      showGhost: () => {},
      clearGhost: () => {},
      showRoute: () => {},
      clearRoute: () => {},
      showBeltPreview: () => {},
      clearBeltPreview: () => {},
      showHeldBelts: () => {},
      clearHeldBelts: () => {},
      showSelection: () => {},
      clearSelection: () => {},
      hoverRing: () => {},
      clearHover: () => {},
      showBeltHandles: () => {},
      clearBeltHandles: () => {},
      showHandleRing: () => {},
      clearHandleRing: () => {},
      showDraggedHandle: () => {},
      clearDraggedHandle: () => {},
      showNubRing: () => {},
      clearNubRing: () => {},
      // No-ops on purpose: this file exercises validAt/setPlacement only, and the
      // ghost controller never paints wire targets. The RECORDING versions that the
      // 66-06 assertions read live in gestures.test.ts, where the wire tool is driven.
      showWireTargets: () => {},
      clearWireTargets: () => {},
      showDockTargets: () => {},
      clearDockTargets: () => {},
      rotateHandleCenter: () => null,
      setRotateHandleHover: () => {},
      showPending: () => {},
      clearPending: () => {},
      showRejectFlash: () => {},
      // CONNECT-02: the ghost rig paints no stranded rings, so the press gate reads
      // false. Fail-closed by construction - no ghost case can start a ring drag,
      // and the retire can only ever answer "nothing was there" (67-REVIEW WR-03).
      alertRingsActive: () => false,
      clearAlertRingAt: () => false,
    },
    cam: {
      screenToCell: (sx: number, sy: number) => ({ cx: sx, cy: sy }),
    } as never,
    getScene: () => scene,
  });

describe("nodeAtCell — footprint membership (the landmine fix)", () => {
  it("returns the ROUTER for a click on its anchor cell", () => {
    const scene = sceneWith(router2x3);
    expect(nodeAtCell(scene, 2, 2)?.id).toBe(42);
  });

  it("returns the ROUTER for a click on ANY non-anchor body cell", () => {
    const scene = sceneWith(router2x3);
    // Every one of the 6 footprint cells must resolve to the ROUTER — not just
    // the anchor (the bug this plan fixes).
    for (const [cx, cy] of [
      [2, 2],
      [3, 2],
      [2, 3],
      [3, 3],
      [2, 4],
      [3, 4],
    ]) {
      expect(nodeAtCell(scene, cx, cy)?.id).toBe(42);
    }
  });

  it("returns undefined for a cell outside every footprint", () => {
    const scene = sceneWith(router2x3);
    expect(nodeAtCell(scene, 4, 2)).toBeUndefined(); // just past the 2-wide box
    expect(nodeAtCell(scene, 2, 5)).toBeUndefined(); // just past the 3-tall box
    expect(nodeAtCell(scene, 0, 0)).toBeUndefined();
  });

  it("still resolves a 1x1 machine at its single cell (degenerate case intact)", () => {
    const scene = sceneWith(node({ id: 7, cell_x: 9, cell_y: 9 }));
    expect(nodeAtCell(scene, 9, 9)?.id).toBe(7);
    expect(nodeAtCell(scene, 9, 10)).toBeUndefined();
  });
});

describe("placement validity — multi-cell aware", () => {
  it("rejects a 2x3 placement overlapping an existing footprint cell", () => {
    const ghost = controllerOn(sceneWith(router2x3));
    ghost.setPlacement(machine_kind.ROUTER, 0);
    // Anchored at (3,3): its box (3,3),(4,3),(3,4)... overlaps the ROUTER at (3,3).
    expect(ghost.validAt({ cx: 3, cy: 3 })).toBe(false);
    // Anchored at (1,1): box reaches (2,2) which the ROUTER occupies.
    expect(ghost.validAt({ cx: 1, cy: 1 })).toBe(false);
  });

  it("accepts a 2x3 placement on a fully-free region", () => {
    const ghost = controllerOn(sceneWith(router2x3));
    ghost.setPlacement(machine_kind.ROUTER, 0);
    // Anchored at (10,10): all 6 cells are clear of the ROUTER at (2,2).
    expect(ghost.validAt({ cx: 10, cy: 10 })).toBe(true);
  });

  it("explicit dims arg overrides the placement context", () => {
    const ghost = controllerOn(sceneWith(router2x3));
    // A 1x1 drop just past the ROUTER box is valid even with no context set.
    expect(ghost.validAt({ cx: 4, cy: 2 }, { w: 1, h: 1, rot: 0 })).toBe(true);
    // A 2x3 drop overlapping the ROUTER is invalid.
    expect(ghost.validAt({ cx: 2, cy: 2 }, { w: 2, h: 3, rot: 0 })).toBe(false);
  });

  it("defaults to a 1x1 probe when no placement context is set", () => {
    const ghost = controllerOn(sceneWith(router2x3));
    // No setPlacement → single-cell behaviour: only the exact cell matters.
    expect(ghost.validAt({ cx: 3, cy: 3 })).toBe(false); // inside ROUTER body
    expect(ghost.validAt({ cx: 4, cy: 2 })).toBe(true); // free 1x1 cell
  });

  it("a multi-cell placement is rejected on the anchor of the occupant itself", () => {
    const ghost = controllerOn(sceneWith(router2x3));
    ghost.setPlacement(machine_kind.ROUTER, 0);
    expect(ghost.validAt({ cx: 2, cy: 2 })).toBe(false);
  });

  it("a rotated placement validates against the EFFECTIVE (dim-swapped) box", () => {
    const ghost = controllerOn(sceneWith(router2x3));
    // rot 1 swaps the 2x3 ROUTER to a 3-wide, 2-tall effective box.
    ghost.setPlacement(machine_kind.ROUTER, 1);
    // Anchored at (1,1): the 3-wide box reaches (2,2) which the ROUTER occupies.
    expect(ghost.validAt({ cx: 1, cy: 1 })).toBe(false);
    // Anchored at (4,1): cells x 4..6, y 1..2 — all clear of the ROUTER (x 2..3).
    expect(ghost.validAt({ cx: 4, cy: 1 })).toBe(true);
    // The UNROTATED 2x3 box at (4,1) would reach (5,3) — still clear — but at
    // (1,1) rot 0 it only spans x 1..2 and hits (2,2) too; distinguish via a
    // cell only the ROTATED box covers: rot 1 at (0,2) spans x 0..2, y 2..3 and
    // hits the ROUTER at (2,2); rot 0 at (0,2) spans x 0..1 and stays clear.
    expect(ghost.validAt({ cx: 0, cy: 2 })).toBe(false);
    ghost.setPlacement(machine_kind.ROUTER, 0);
    expect(ghost.validAt({ cx: 0, cy: 2 })).toBe(true);
  });
});

// CTRL-03 / D-14: the ghost previews the ROTATED catalog ports. setPlacement
// maps catalogEntry(kind).ports through rotateCatalogPort (the port_world
// closed-form mirror — the ONLY legal local rotation; placed nodes always use
// host-resolved ports[]) and passes the specs as showGhost's 4th argument.
describe("rotated catalog port preview (CTRL-03)", () => {
  interface GhostCall {
    cell: { cx: number; cy: number };
    valid: boolean;
    dims?: { w: number; h: number; rot: number };
    ports?: Array<{ lx: number; ly: number; side: number; role: number; medium?: number }>;
  }

  const recordingController = (
    scene: SceneState,
  ): { ghost: GhostController; calls: GhostCall[] } => {
    const calls: GhostCall[] = [];
    const ghost = createGhostController({
      overlay: {
        showGhost: (cell, valid, dims, ports) => {
          calls.push({ cell, valid, dims, ports });
        },
        clearGhost: () => {},
        showRoute: () => {},
        clearRoute: () => {},
        showBeltPreview: () => {},
        clearBeltPreview: () => {},
        showHeldBelts: () => {},
        clearHeldBelts: () => {},
        showSelection: () => {},
        clearSelection: () => {},
        hoverRing: () => {},
        clearHover: () => {},
        showBeltHandles: () => {},
        clearBeltHandles: () => {},
        showHandleRing: () => {},
        clearHandleRing: () => {},
        showDraggedHandle: () => {},
        clearDraggedHandle: () => {},
        showNubRing: () => {},
        clearNubRing: () => {},
        // No-ops: see the note on the sibling stub above.
        showWireTargets: () => {},
        clearWireTargets: () => {},
        showDockTargets: () => {},
        clearDockTargets: () => {},
        rotateHandleCenter: () => null,
        setRotateHandleHover: () => {},
        showPending: () => {},
        clearPending: () => {},
        showRejectFlash: () => {},
        // CONNECT-02: the ghost rig paints no stranded rings, so the press gate reads
        // false. Fail-closed by construction - no ghost case can start a ring drag,
        // and the retire can only ever answer "nothing was there" (67-REVIEW WR-03).
        alertRingsActive: () => false,
        clearAlertRingAt: () => false,
      },
      cam: {
        screenToCell: (sx: number, sy: number) => ({ cx: sx, cy: sy }),
      } as never,
      getScene: () => scene,
    });
    return { ghost, calls };
  };

  it("rot 0 passes the catalog ports through unchanged", () => {
    const { ghost, calls } = recordingController(sceneWith());
    // ROUTER catalog (2x3), moved in 74.1-14 (the ruling 2026-10-04, "Edits keep
    // middle layout"): In at rot-0 local (0,1) side W(3); then ROUTER_OUT_ARITY Outs
    // on the E edge on rows 1, 2, 0, the port-edit reseat rule's centre-out slots.
    // (Until 74.1-14: In (0,0) and Outs on rows 2, 0, 1.)
    ghost.setPlacement(machine_kind.ROUTER, 0);
    ghost.show({ cx: 5, cy: 5 }, true);
    expect(calls.at(-1)?.dims).toEqual({ w: 2, h: 3, rot: 0 });
    expect(calls.at(-1)?.ports).toEqual([
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

  it("rot 1 rotates the preview via the port_world closed form", () => {
    const { ghost, calls } = recordingController(sceneWith());
    ghost.setPlacement(machine_kind.ROUTER, 1);
    ghost.show({ cx: 5, cy: 5 }, true);
    expect(calls.at(-1)?.dims).toEqual({ w: 2, h: 3, rot: 1 });
    // Hand-computed closed form (r=1: [lx,ly] = [h-1-y, x], side = (side+1)&3), on the
    // 74.1-14 catalog:
    //   In  (0,1) W(3) -> (3-1-1, 0) = (1,0), side N(0)
    //   Out (1,1) E(1) -> (3-1-1, 1) = (1,1), side S(2)
    //   Out (1,2) E(1) -> (3-1-2, 1) = (0,1), side S(2)
    //   Out (1,0) E(1) -> (3-1-0, 1) = (2,1), side S(2)
    expect(calls.at(-1)?.ports).toEqual([
      { lx: 1, ly: 0, side: 0, role: 0, medium: 0 },
      { lx: 1, ly: 1, side: 2, role: 1, medium: 0 },
      { lx: 0, ly: 1, side: 2, role: 1, medium: 0 },
      { lx: 2, ly: 1, side: 2, role: 1, medium: 0 },
      // PILE-10's Fault nub through the SAME closed form, hand-computed like its
      // neighbours: Fault (0,2) S(2) -> (3-1-2, 0) = (0,0), side (2+1)&3 = W(3).
      { lx: 0, ly: 0, side: 3, role: 2, medium: 0 },
    ]);
  });

  it("moveTo previews the same rotated ports as show", () => {
    const { ghost, calls } = recordingController(sceneWith());
    ghost.setPlacement(machine_kind.ROUTER, 1);
    ghost.moveTo(7, 7);
    expect(calls.at(-1)?.ports).toEqual([
      { lx: 1, ly: 0, side: 0, role: 0, medium: 0 },
      { lx: 1, ly: 1, side: 2, role: 1, medium: 0 },
      { lx: 0, ly: 1, side: 2, role: 1, medium: 0 },
      { lx: 2, ly: 1, side: 2, role: 1, medium: 0 },
      // PILE-10's Fault nub through the SAME closed form, hand-computed like its
      // neighbours: Fault (0,2) S(2) -> (3-1-2, 0) = (0,0), side (2+1)&3 = W(3).
      { lx: 0, ly: 0, side: 3, role: 2, medium: 0 },
    ]);
  });

  it("clearing the placement drops the port preview", () => {
    const { ghost, calls } = recordingController(sceneWith());
    ghost.setPlacement(machine_kind.ROUTER, 1);
    ghost.setPlacement(null);
    ghost.show({ cx: 5, cy: 5 }, true);
    expect(calls.at(-1)?.dims).toBeUndefined();
    expect(calls.at(-1)?.ports).toBeUndefined();
  });
});

// hide() vs clear(): the two jobs `clear()` used to do at once.
//
// `clear()` hid the ghost AND destroyed the arm. The gesture layer calls it on
// every pointermove that lands off the canvas, so the cursor merely passing over
// the palette nulled `placement` — after which validAt fell back to `{w:1,h:1}`
// and showGhost lost its dims. `hide()` is the visual half alone: the arm stays.
describe("hide() vs clear() — hiding the ghost must not disarm it", () => {
  interface Drawn {
    cell: { cx: number; cy: number };
    valid: boolean;
    dims?: { w: number; h: number; rot: number };
    ports?: Array<{ lx: number; ly: number; side: number; role: number; medium?: number }>;
  }

  /** A controller that records showGhost calls and clearGhost invocations. */
  const spyController = (
    scene: SceneState,
  ): { ghost: GhostController; drawn: Drawn[]; cleared: () => number } => {
    const drawn: Drawn[] = [];
    let cleared = 0;
    const ghost = createGhostController({
      overlay: {
        showGhost: (cell, valid, dims, ports) => {
          drawn.push({ cell, valid, dims, ports });
        },
        clearGhost: () => {
          cleared++;
        },
        showRoute: () => {},
        clearRoute: () => {},
        showBeltPreview: () => {},
        clearBeltPreview: () => {},
        showHeldBelts: () => {},
        clearHeldBelts: () => {},
        showSelection: () => {},
        clearSelection: () => {},
        hoverRing: () => {},
        clearHover: () => {},
        showBeltHandles: () => {},
        clearBeltHandles: () => {},
        showHandleRing: () => {},
        clearHandleRing: () => {},
        showDraggedHandle: () => {},
        clearDraggedHandle: () => {},
        showNubRing: () => {},
        clearNubRing: () => {},
        // No-ops: see the note on the first stub in this file.
        showWireTargets: () => {},
        clearWireTargets: () => {},
        showDockTargets: () => {},
        clearDockTargets: () => {},
        rotateHandleCenter: () => null,
        setRotateHandleHover: () => {},
        showPending: () => {},
        clearPending: () => {},
        showRejectFlash: () => {},
        // CONNECT-02: the ghost rig paints no stranded rings, so the press gate reads
        // false. Fail-closed by construction - no ghost case can start a ring drag,
        // and the retire can only ever answer "nothing was there" (67-REVIEW WR-03).
        alertRingsActive: () => false,
        clearAlertRingAt: () => false,
      },
      cam: {
        screenToCell: (sx: number, sy: number) => ({ cx: sx, cy: sy }),
      } as never,
      getScene: () => scene,
    });
    return { ghost, drawn, cleared: () => cleared };
  };

  it("hide() keeps the FULL 2x3 footprint in the validity check", () => {
    const ghost = controllerOn(sceneWith(router2x3));
    ghost.setPlacement(machine_kind.ROUTER, 0);
    ghost.hide();
    // (1,1) is a free ANCHOR whose 2x3 box reaches the occupant at (2,2).
    // A degraded 1x1 probe reports this valid; the real footprint does not.
    expect(ghost.validAt({ cx: 1, cy: 1 })).toBe(false);
    expect(ghost.validAt({ cx: 10, cy: 10 })).toBe(true);
  });

  it("hide() keeps the dims and port preview on the next showGhost", () => {
    const { ghost, drawn } = spyController(sceneWith());
    ghost.setPlacement(machine_kind.ROUTER, 1);
    ghost.hide();
    ghost.show({ cx: 5, cy: 5 }, true);
    expect(drawn.at(-1)?.dims).toEqual({ w: 2, h: 3, rot: 1 });
    expect(drawn.at(-1)?.ports).toEqual([
      { lx: 1, ly: 0, side: 0, role: 0, medium: 0 },
      { lx: 1, ly: 1, side: 2, role: 1, medium: 0 },
      { lx: 0, ly: 1, side: 2, role: 1, medium: 0 },
      { lx: 2, ly: 1, side: 2, role: 1, medium: 0 },
      // PILE-10's Fault nub through the SAME closed form, hand-computed like its
      // neighbours: Fault (0,2) S(2) -> (3-1-2, 0) = (0,0), side (2+1)&3 = W(3).
      { lx: 0, ly: 0, side: 3, role: 2, medium: 0 },
    ]);
  });

  it("hide() drops the current cell and calls clearGhost", () => {
    const { ghost, cleared } = spyController(sceneWith());
    ghost.setPlacement(machine_kind.ROUTER, 0);
    ghost.show({ cx: 5, cy: 5 }, true);
    expect(ghost.current()).toEqual({ cx: 5, cy: 5 });
    ghost.hide();
    expect(ghost.current()).toBeNull();
    expect(cleared()).toBe(1);
  });

  it("clear() STILL disarms — the genuine put-the-tool-down path is unchanged", () => {
    const ghost = controllerOn(sceneWith(router2x3));
    ghost.setPlacement(machine_kind.ROUTER, 0);
    ghost.clear();
    // Back to the 1x1 default: only the anchor cell matters again.
    expect(ghost.validAt({ cx: 1, cy: 1 })).toBe(true);
    expect(ghost.current()).toBeNull();
  });

  it("clear() STILL drops the dims and port preview on the next showGhost", () => {
    const { ghost, drawn } = spyController(sceneWith());
    ghost.setPlacement(machine_kind.ROUTER, 1);
    ghost.clear();
    ghost.show({ cx: 5, cy: 5 }, true);
    expect(drawn.at(-1)?.dims).toBeUndefined();
    expect(drawn.at(-1)?.ports).toBeUndefined();
  });
});

// The ghost used to paint valid-blue over a belt tile: `validAt` asked
// `nodeAtCell`, which iterates `scene.nodes` only, while the host's occupancy
// index counts every belt tile. The user clicked on the promise and NOTHING AT
// ALL happened - the host refused and the refusal went nowhere. `validAt` now
// consults `cellOccupied`, the one frontend occupancy definition (drift F, D-24).
describe("placement validity - belt-aware occupancy (drift F)", () => {
  it("rejects a 1x1 drop on a belt tile (it used to paint valid-blue and the click did nothing)", () => {
    const scene = withBelts(
      sceneWith(router2x3),
      belt(10, [
        [7, 3],
        [8, 3],
      ]),
    );
    const ghost = controllerOn(scene);
    // Both tiles of belt 10, the exact cells the phase tracer arms a Source over.
    expect(ghost.validAt({ cx: 7, cy: 3 })).toBe(false);
    expect(ghost.validAt({ cx: 8, cy: 3 })).toBe(false);
  });

  it("still accepts a free cell while belts exist elsewhere in the scene", () => {
    const scene = withBelts(
      sceneWith(router2x3),
      belt(10, [
        [7, 3],
        [8, 3],
      ]),
    );
    const ghost = controllerOn(scene);
    // Adjacent to the belt on every side, but on no tile of it.
    expect(ghost.validAt({ cx: 7, cy: 2 })).toBe(true);
    expect(ghost.validAt({ cx: 9, cy: 3 })).toBe(true);
    expect(ghost.validAt({ cx: 6, cy: 3 })).toBe(true);
  });

  it("rejects a multi-cell footprint whose ROTATED box covers exactly one belt tile", () => {
    // rot 1 anchors the 2x3 ROUTER as a 3-wide, 2-tall box: at (4,1) it spans
    // x 4..6, y 1..2. A single belt tile at (6,2) sits in that box and in no
    // other cell of it - and the UNROTATED box at (4,1) (x 4..5) misses it.
    const scene = withBelts(
      sceneWith(router2x3),
      belt(11, [
        [6, 2],
        [6, 1],
      ]),
    );
    const ghostRot = controllerOn(scene);
    ghostRot.setPlacement(machine_kind.ROUTER, 1);
    expect(ghostRot.validAt({ cx: 4, cy: 1 })).toBe(false);

    const scene2 = withBelts(sceneWith(router2x3), belt(11, [[6, 2]]));
    const ghostFlat = controllerOn(scene2);
    ghostFlat.setPlacement(machine_kind.ROUTER, 0);
    expect(ghostFlat.validAt({ cx: 4, cy: 1 })).toBe(true);
  });

  it("still rejects a cell inside a node footprint, belts present or not", () => {
    const scene = withBelts(
      sceneWith(router2x3),
      belt(10, [
        [7, 3],
        [8, 3],
      ]),
    );
    const ghost = controllerOn(scene);
    expect(ghost.validAt({ cx: 3, cy: 3 })).toBe(false); // ROUTER body cell
    expect(ghost.validAt({ cx: 2, cy: 4 })).toBe(false); // its far corner
  });

  it("with an EMPTY belts map behaves exactly as the node-only predicate did", () => {
    const scene = withBelts(sceneWith(router2x3)); // no belts added
    const ghost = controllerOn(scene);
    expect(ghost.validAt({ cx: 3, cy: 3 })).toBe(false); // inside the ROUTER
    expect(ghost.validAt({ cx: 4, cy: 2 })).toBe(true); // free 1x1 cell
    expect(ghost.validAt({ cx: 7, cy: 3 })).toBe(true); // where a belt WOULD be
    ghost.setPlacement(machine_kind.ROUTER, 0);
    expect(ghost.validAt({ cx: 10, cy: 10 })).toBe(true); // free 2x3 region
    expect(ghost.validAt({ cx: 1, cy: 1 })).toBe(false); // box reaches (2,2)
  });
});

// Phase 76 (SHAPE-10, D-01): a Label takes its cells exactly like a machine, so the ONE
// occupancy prediction (`cellOccupied` through `nodeAtCell`) needs nothing label-specific:
// every cell of a 4x1 label is occupied, a ghost over any of them is invalid, and the
// LABEL ghost itself is the catalog's 4x1 box with no nubs.
describe("a 4x1 Label on the board (phase 76)", () => {
  const label4x1 = node({ id: 77, kind: machine_kind.LABEL, cell_x: 10, cell_y: 12, w: 4, h: 1 });

  it("every one of its four cells is occupied, and the cell past its box is not", () => {
    const scene = sceneWith(label4x1);
    for (const cx of [10, 11, 12, 13]) {
      expect(cellOccupied(scene, cx, 12), `label cell (${cx},12)`).toBe(true);
      expect(nodeAtCell(scene, cx, 12)?.id).toBe(77);
    }
    expect(cellOccupied(scene, 14, 12)).toBe(false);
    expect(cellOccupied(scene, 10, 13)).toBe(false);
  });

  it("a machine ghost over any label cell is invalid; beside it, valid", () => {
    const ghost = controllerOn(sceneWith(label4x1));
    ghost.setPlacement(machine_kind.SOURCE, 0);
    for (const cx of [10, 11, 12, 13]) {
      expect(ghost.validAt({ cx, cy: 12 }), `Source ghost on (${cx},12)`).toBe(false);
    }
    expect(ghost.validAt({ cx: 14, cy: 12 })).toBe(true);
  });

  it("a LABEL ghost overlapping the label is invalid, and the LABEL ghost is 4x1 with no nubs", () => {
    const calls: Array<{ dims?: { w: number; h: number; rot: number }; ports?: unknown[]; valid: boolean }> = [];
    const overlay = new Proxy(
      {},
      {
        get: (_t, k) =>
          k === "showGhost"
            ? (_cell: unknown, valid: boolean, dims?: { w: number; h: number; rot: number }, ports?: unknown[]) =>
                calls.push({ valid, dims, ports })
            : k === "rotateHandleCenter"
              ? () => null
              : k === "alertRingsActive" || k === "clearAlertRingAt"
                ? () => false
                : () => {},
      },
    );
    const ghost = createGhostController({
      overlay: overlay as never,
      cam: { screenToCell: (sx: number, sy: number) => ({ cx: sx, cy: sy }) } as never,
      getScene: () => sceneWith(label4x1),
    });
    ghost.setPlacement(machine_kind.LABEL, 0);
    // Anchored at (7,12) the 4x1 box reaches (10,12); at (6,12) it ends at (9,12).
    expect(ghost.validAt({ cx: 7, cy: 12 })).toBe(false);
    expect(ghost.validAt({ cx: 6, cy: 12 })).toBe(true);
    ghost.moveTo(6, 12);
    expect(calls.at(-1)?.dims).toEqual({ w: 4, h: 1, rot: 0 });
    expect(calls.at(-1)?.ports ?? []).toEqual([]);
    expect(calls.at(-1)?.valid).toBe(true);
  });
});

// Plan 76-03 (76-UI-SPEC 5.4, U-5): the label's pending-size outline asks the SAME
// prediction the ghost asks, with the label's own id excluded. A label 4 by 1 at (10,12)
// growing to 7 by 2 with a Merge-sized neighbour at (17,12) and a belt tile at (10,15).
describe("footprintFits - the one prediction, with the resized label's own cells excluded", () => {
  const label = node({ id: 7, kind: machine_kind.LABEL, cell_x: 10, cell_y: 12, w: 4, h: 1 });
  const merge = node({ id: 8, kind: machine_kind.MERGE, cell_x: 17, cell_y: 12, w: 1, h: 1 });
  const board = (): SceneState => withBelts(sceneWith(label, merge), belt(30, [[10, 15], [11, 15]]));
  const at = { cx: 10, cy: 12 };

  it("is true for free cells, and ignores the label's own cells", () => {
    expect(footprintFits(board(), at, { w: 7, h: 2, rot: 0 }, 7)).toBe(true);
    // Shrinking, or re-stating the committed size, never collides with itself.
    expect(footprintFits(board(), at, { w: 4, h: 1, rot: 0 }, 7)).toBe(true);
    expect(footprintFits(board(), at, { w: 1, h: 1, rot: 0 }, 7)).toBe(true);
  });

  it("is false without the exclusion: the label's own cells are occupied to everyone else", () => {
    expect(footprintFits(board(), at, { w: 4, h: 1, rot: 0 })).toBe(false);
  });

  it("is false for a cell another node holds", () => {
    expect(footprintFits(board(), at, { w: 8, h: 2, rot: 0 }, 7)).toBe(false);
  });

  it("is false for a cell a belt routes through", () => {
    expect(footprintFits(board(), at, { w: 4, h: 4, rot: 0 }, 7)).toBe(false);
    expect(footprintFits(board(), at, { w: 4, h: 3, rot: 0 }, 7)).toBe(true);
  });

  it("is false past the grid edge, inclusive bounds", () => {
    const edge = { cx: GRID_MAX - 3, cy: 0 };
    expect([GRID_MIN, GRID_MAX]).toEqual([-512, 512]);
    expect(footprintFits(createSceneState(), edge, { w: 4, h: 1, rot: 0 })).toBe(true);
    expect(footprintFits(createSceneState(), edge, { w: 5, h: 1, rot: 0 })).toBe(false);
    expect(footprintFits(createSceneState(), { cx: GRID_MIN - 1, cy: 0 }, { w: 1, h: 1, rot: 0 })).toBe(false);
  });

  it("cellOccupied with no exclusion answers exactly as before", () => {
    expect(cellOccupied(board(), 10, 12)).toBe(true);
    expect(cellOccupied(board(), 10, 12, 7)).toBe(false);
    expect(cellOccupied(board(), 17, 12, 7)).toBe(true);
  });
});

// Phase 88, plan 88-07 (BELT-06, D-09): the queued gestures are part of the one occupancy
// definition. A claim the scene's store holds reads as occupied; an unclaimed cell reads
// exactly as before; and `footprintFits` reads through it with no change of its own.
describe("cellOccupied and footprintFits read the queued claims (plan 88-07)", () => {
  const store = createQueuedClaims();
  const claimed = (): SceneState => {
    const scene = sceneWith();
    store.clear();
    store.add(1, beltClaim([[3, 5], [4, 5], [5, 5]], null), { generation: scene.generation });
    store.add(2, resizeClaim({ id: 9, cx: 10, cy: 12, w: 4, h: 1 }, 6, 1), { generation: scene.generation });
    scene.queuedClaims = store;
    return scene;
  };

  it("a claimed cell reads as occupied, and an unclaimed one exactly as before", () => {
    const scene = claimed();
    expect(cellOccupied(scene, 4, 5), "a held belt's tile").toBe(true);
    expect(cellOccupied(scene, 15, 12), "a queued label grow's new cell").toBe(true);
    expect(cellOccupied(scene, 4, 6), "a free cell beside them").toBe(false);
    expect(cellOccupied(sceneWith(), 4, 5), "the same cell on a scene with no store").toBe(false);
  });

  it("the exclude rule applies to claims: the label's own resize claim does not count against it", () => {
    const scene = claimed();
    expect(cellOccupied(scene, 15, 12, 9), "label 9's own queued grow").toBe(false);
    expect(cellOccupied(scene, 4, 5, 9), "but another gesture's claim still counts").toBe(true);
  });

  it("footprintFits reads false with a claimed cell in the box, true once the claim ends", () => {
    const scene = claimed();
    expect(footprintFits(scene, { cx: 5, cy: 4 }, { w: 1, h: 2, rot: 0 }), "(5,5) is held").toBe(false);
    store.add(1, beltClaim([], null), { generation: scene.generation });
    expect(footprintFits(scene, { cx: 5, cy: 4 }, { w: 1, h: 2, rot: 0 }), "replaced by an empty claim").toBe(true);
  });
});
