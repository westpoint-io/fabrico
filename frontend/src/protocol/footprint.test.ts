import { describe, expect, it } from 'vitest';
import { cellsOfFootprint, effectiveBox } from './footprint.ts';
import { catalogEntry } from './decode.ts';
import { machine_kind } from './kinds.ts';

// The TS footprint primitive must be byte-order-identical to the core
// `cells_of_footprint` (crates/fabrico-core/src/state.rs:698). These cases are
// pinned to the exact expectations asserted in the Rust state.rs cell-expansion
// tests (state.rs:2067-2081) so the TS mirror can never drift from the sim.

describe('cellsOfFootprint', () => {
  it('1x1 at (5,5) yields exactly its anchor cell (degenerate, any rot)', () => {
    // A 1x1 footprint is the degenerate case the renderer assumes: one cell, the
    // anchor, for every rotation.
    expect(cellsOfFootprint(5, 5, 1, 1, 0)).toEqual([[5, 5]]);
    expect(cellsOfFootprint(5, 5, 1, 1, 1)).toEqual([[5, 5]]);
    expect(cellsOfFootprint(5, 5, 1, 1, 2)).toEqual([[5, 5]]);
    expect(cellsOfFootprint(5, 5, 1, 1, 3)).toEqual([[5, 5]]);
  });

  it('2x3 rot0 at (2,2) yields the 6 cells in core row-major order', () => {
    // Mirror of state_claim_footprint_multicell_indexes_every_body_cell — a 2x3
    // claim at (2,2) covers all 6 body cells; (4,2) is outside the body.
    const cells = cellsOfFootprint(2, 2, 2, 3, 0);
    expect(cells.length).toBe(6);
    expect(cells).toEqual([
      [2, 2],
      [3, 2],
      [2, 3],
      [3, 3],
      [2, 4],
      [3, 4],
    ]);
    // A cell outside the body is NOT a member.
    expect(cells).not.toContainEqual([4, 2]);
  });

  it('2x3 rot0 at (10,20): anchor first, i inner advances x, j outer advances y', () => {
    // Pinned to state_cells_of_footprint_swaps_box_on_odd_rot_and_yields_w_times_h
    // (even branch).
    const even = cellsOfFootprint(10, 20, 2, 3, 0);
    expect(even.length).toBe(6);
    expect(even[0]).toEqual([10, 20]); // first cell is the anchor (min-corner)
    expect(even[1]).toEqual([11, 20]); // i inner advances x first
    expect(even[2]).toEqual([10, 21]); // j outer advances y
  });

  it('2x3 rot1 at (10,20) swaps the effective box to 3 wide x 2 tall', () => {
    // Pinned to the odd-rot branch of the same core test: dim swap (w,h)->(h,w),
    // anchor fixed, still 6 cells.
    const odd = cellsOfFootprint(10, 20, 2, 3, 1);
    expect(odd.length).toBe(6);
    expect(odd[0]).toEqual([10, 20]); // anchor preserved under rotation
    expect(odd[1]).toEqual([11, 20]);
    expect(odd[2]).toEqual([12, 20]); // effective width is now h=3
    expect(odd).toEqual([
      [10, 20],
      [11, 20],
      [12, 20],
      [10, 21],
      [11, 21],
      [12, 21],
    ]);
  });

  it('odd rot (3) swaps the box identically to rot 1', () => {
    // rot & 1 is the only parity that matters for the effective box.
    expect(cellsOfFootprint(0, 0, 2, 3, 3)).toEqual(
      cellsOfFootprint(0, 0, 2, 3, 1),
    );
    // even rots (0,2) agree on the box too.
    expect(cellsOfFootprint(0, 0, 2, 3, 2)).toEqual(
      cellsOfFootprint(0, 0, 2, 3, 0),
    );
  });
});

describe('effectiveBox', () => {
  // The renderer's body-extent mirror of the core effective-box swap — the same
  // `(rot & 1)` parity `cellsOfFootprint` uses. Even rot keeps (w,h); odd rot
  // swaps to (h,w). Drives the multi-cell machine body rect (machines.ts).
  it('even rot (0,2) keeps (w,h)', () => {
    expect(effectiveBox(2, 3, 0)).toEqual({ ew: 2, eh: 3 });
    expect(effectiveBox(2, 3, 2)).toEqual({ ew: 2, eh: 3 });
  });

  it('odd rot (1,3) swaps to (h,w)', () => {
    expect(effectiveBox(2, 3, 1)).toEqual({ ew: 3, eh: 2 });
    expect(effectiveBox(2, 3, 3)).toEqual({ ew: 3, eh: 2 });
  });

  it('1x1 is invariant under every rotation (degenerate renderer case)', () => {
    for (const rot of [0, 1, 2, 3]) {
      expect(effectiveBox(1, 1, rot)).toEqual({ ew: 1, eh: 1 });
    }
  });

  it('agrees with cellsOfFootprint extent (single primitive, no drift)', () => {
    const { ew, eh } = effectiveBox(2, 3, 1);
    expect(cellsOfFootprint(0, 0, 2, 3, 1).length).toBe(ew * eh);
  });
});

// The frontend catalog surface (CAT-05) replaced the hand-maintained per-kind dims
// table (CLEAN-05) with a SMALLER hand-maintained table: `MACHINE_CATALOG` in
// decode.ts still mirrors the core `port_catalog`
// (crates/fabrico-command/src/command.rs) BY HAND. These cases are the whole of what
// holds the two in step - there is no cross-language catalog byte gate, contrary to
// what this comment said until 63-07 (ts-rs exports the catalog TYPES, never its
// VALUES). So when the Rust catalog changes, THESE cases are what must fail.
describe('catalogEntry (core-authoritative ghost catalog)', () => {
  it('ROUTER is 2x3 with three Out nubs and a Fault nub last (ROUTE-02 + PILE-10)', () => {
    const e = catalogEntry(machine_kind.ROUTER);
    expect({ w: e.w, h: e.h }).toEqual({ w: 2, h: 3 });
    // Index 0 is the In and indices 1..3 the Outs: a PortId is an index into this
    // list, so an insert anywhere but the end would re-point every dock that already
    // addresses a port. The CELLS moved in 74.1-14 (the ruling of 2026-10-04, "Edits
    // keep middle layout"): the In to the middle row (0,1) and the Outs to rows 1, 2,
    // 0, the port-edit reseat rule's slots, from In (0,0) and Out rows 2, 0, 1.
    //
    // MOVED in phase 71 (PILE-10, 71-CONTEXT D-07): index 4 is a real spatial
    // `Role::Fault` nub at S@(0,2), APPENDED so it sorts last under ROUTE-06 and shifts
    // no existing index. The four rows above it kept their indices, which is the
    // property that actually matters. The 2x3 box does not
    // grow: the nub takes the bottom-LEFT cell of the frozen footprint.
    expect(e.ports.map((p) => p.role)).toEqual([0, 1, 1, 1, 2]);
    expect(e.ports.map((p) => [p.index, p.local_x, p.local_y])).toEqual([
      [0, 0, 1],
      [1, 1, 1],
      [2, 1, 2],
      [3, 1, 0],
      [4, 0, 2],
    ]);
    // The nub faces S, which is what puts the fault drain off the E output column.
    expect(e.ports[4].side).toBe(2);
  });

  it('FACTORY is 3x3 with the Fault port at array index 2 (S-center, sorts last)', () => {
    const e = catalogEntry(machine_kind.FACTORY);
    expect({ w: e.w, h: e.h }).toEqual({ w: 3, h: 3 });
    expect(e.ports.map((p) => p.role)).toEqual([0, 1, 2]); // In, Out, Fault
    const fault = e.ports[2];
    // Fault = role 2, S-center: local (1,2), side S=2.
    expect({ index: fault.index, x: fault.local_x, y: fault.local_y, side: fault.side, role: fault.role })
      .toEqual({ index: 2, x: 1, y: 2, side: 2, role: 2 });
  });

  // RENAMED in phase 71, not just re-numbered. It read 'SOURCE / SINK are 1x1
  // single-port machines', which was true and is now false of the SINK: PILE-10 gives it
  // a `Role::Fault` nub so a user can drag a belt onto it. The claim that survives, and
  // the one worth pinning, is that the BOX did not grow - both of the Sink's nubs sit on
  // the one cell, the ENDPOINT precedent.
  it('SOURCE is 1x1 single-port; SINK is 1x1 with In then Fault on the ONE cell', () => {
    expect({ w: catalogEntry(machine_kind.SOURCE).w, h: catalogEntry(machine_kind.SOURCE).h }).toEqual({ w: 1, h: 1 });
    expect({ w: catalogEntry(machine_kind.SINK).w, h: catalogEntry(machine_kind.SINK).h }).toEqual({ w: 1, h: 1 });
    expect(catalogEntry(machine_kind.SOURCE).ports).toHaveLength(1);

    const sink = catalogEntry(machine_kind.SINK);
    expect(sink.ports.map((p) => p.role)).toEqual([0, 2]); // In, Fault - Fault LAST
    // BOTH on local (0,0): the box is 1x1 and the second nub must not have grown it.
    expect(sink.ports.map((p) => [p.index, p.local_x, p.local_y])).toEqual([
      [0, 0, 0],
      [1, 0, 0],
    ]);
    // In faces W, Fault faces S. Not E, and that is the measured choice rather than a
    // free one: every other kind puts its Out on E, so a fault nub there would read as
    // the main line continuing - the wrong idea on a terminal.
    expect(sink.ports.map((p) => p.side)).toEqual([3, 2]); // Side: N=0 E=1 S=2 W=3
  });

  it('TEE / BALANCER / MERGE are 2x2 routing machines', () => {
    for (const k of [machine_kind.TEE, machine_kind.BALANCER, machine_kind.MERGE]) {
      const e = catalogEntry(k);
      expect({ w: e.w, h: e.h }).toEqual({ w: 2, h: 2 });
    }
  });

  it('BELT is not a placeable machine → 1x1 portless fallback', () => {
    const e = catalogEntry(machine_kind.BELT);
    expect({ w: e.w, h: e.h }).toEqual({ w: 1, h: 1 });
    expect(e.ports).toHaveLength(0);
  });
});
