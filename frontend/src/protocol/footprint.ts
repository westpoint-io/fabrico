// footprint.ts — the single shared multi-cell footprint primitive for the TS
// renderer/interaction layers. This is a FAITHFUL mirror of the core
// `cells_of_footprint` (crates/fabrico-core/src/state.rs:698) so hit-testing,
// ghost validity, draw-belt occupancy and `window.__fabrico.cells[]` all expand a
// footprint the SAME way the sim does — one primitive, no scattered, drifting
// rectangle math (Don't-Hand-Roll).
//
// INTEGER-ONLY: pure cell arithmetic, no floats — byte-order-identical to core.

/**
 * The effective bounding box of a footprint: `(w, h)` when `rot` is even and
 * `(h, w)` when odd (the core dim-swap on rotation). This is the SINGLE source
 * of the swap parity — `cellsOfFootprint` (cell expansion) and the renderer's
 * multi-cell machine body rect (machines.ts) both derive their extent from it,
 * so the canvas body and the occupied cells can never disagree.
 *
 * Mirrors the `(rot & 1)` swap in crates/fabrico-core/src/state.rs:698.
 */
export function effectiveBox(
  w: number,
  h: number,
  rot: number,
): { ew: number; eh: number } {
  return (rot & 1) === 0 ? { ew: w, eh: h } : { ew: h, eh: w };
}

/**
 * Expand a footprint into its occupied world cells — the TS mirror of core
 * `cells_of_footprint`.
 *
 * The effective box `(we, he)` is `(w, h)` when `rot` is even and `(h, w)` when
 * odd (dim swap), anchored at the fixed min-corner `(cellX, cellY)`. Yields
 * exactly `we*he` cells in row-major (`j` outer, `i` inner) deterministic order:
 * `{ (cellX+i, cellY+j) | 0 <= i < we, 0 <= j < he }`. A 1x1 footprint yields its
 * single anchor cell for every `rot` (the degenerate case the renderer assumes).
 *
 * Mirrors crates/fabrico-core/src/state.rs:698 — keep byte-order-identical.
 */
export function cellsOfFootprint(
  cellX: number,
  cellY: number,
  w: number,
  h: number,
  rot: number,
): [number, number][] {
  const { ew: we, eh: he } = effectiveBox(w, h, rot);
  const cells: [number, number][] = [];
  // Row-major: j outer (advances y), i inner (advances x first) — matches the
  // core `(0..he).flat_map(|j| (0..we).map(|i| (ax+i, ay+j)))` iteration order.
  for (let j = 0; j < he; j++) {
    for (let i = 0; i < we; i++) {
      cells.push([cellX + i, cellY + j]);
    }
  }
  return cells;
}
