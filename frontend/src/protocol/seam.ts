/**
 * THE SEAM TABLE IN TYPESCRIPT (phase 74.1 plan 08): a 1:1 port of Rust `seam_end_kind`
 * (`crates/fabrico-core/src/state.rs`), plus the end-tile composition that mirrors
 * `GridState::effective_belt_tiles`.
 *
 * WHO CALLS THIS, AND WHO MUST NOT. The RENDERER does not: the host ships each docked
 * belt end already derived (`render_packet.rs` `current_views` calls
 * `effective_belt_tiles`), and a second derivation on the wire's far side would be a
 * second truth for a tile kind. The only frontend callers are the draw PREVIEW, which
 * has a pending dock and no echo yet, so it must predict the kind the host will ship
 * (preview equals commit, BELT-03), the draw RELEASE, which hands that same prediction
 * to the renderer until the Dock echoes (the render-side registry, plan 74.1-20), and
 * the parity test.
 *
 * HELD TO THE RUST RULE BY A FROZEN GOLDEN. `crates/fabrico-command/tests/seam_golden.rs`
 * freezes the Rust answer over every reachable input into `seam.bin`; `seam.test.ts`
 * decodes it and requires this function to agree case by case. Change the table on one
 * side only and one of the two goes red.
 *
 * Numbering, shared with the wire: `Dir` N=0 E=1 S=2 W=3 (y-down), `Axis` X=0 Y=1.
 * Pure, integer-only, render-side; nothing here reaches a `GridCommand` (the DrawBelt
 * wire carries cells, never kinds).
 */
import type { TileKindView, TileView } from './decode.ts';
import { sideOfUnitDelta } from './ports.ts';

/** The run axis a flow along `d` travels: N/S on Y (1), E/W on X (0). */
function travelAxis(d: number): number {
  return d === 1 || d === 3 ? 0 : 1;
}

/** The flow directly against `d`. */
function reverseDir(d: number): number {
  return (d + 2) & 3;
}

/**
 * The kind a docked belt END tile is DRAWN as (Rust `seam_end_kind`, same contract):
 *
 * - `stored`: the end tile's authored kind, the one `route()` typed.
 * - `ownIn` / `ownOut`: the belt's own in and out direction at this tile, or `null`
 *   for a single-tile belt, which has none.
 * - `feeds`: the flows arriving into the tile from every partner feeding the Tail.
 * - `drain`: the flow leaving the tile into the Head's partner, or `null`.
 *
 * Entry `e` is the single feed when there is exactly one, else `ownIn`; exit `x` is the
 * drain when there is one, else `ownOut`; a single tile with one seam takes it for both.
 * `e == x` on a SINGLE tile (`ownIn` and `ownOut` both null) is the zero-turn
 * `Corner{from: e, to: e}` (phase 89, BELT-10, D-15: a straight carries only an axis, so a
 * one-tile belt flowing West or North would be drawn flowing East or South); `e == x` on a
 * multi-tile end is Straight on that axis; perpendicular is `Corner{from: e, to: x}`; and
 * every other case returns `stored` itself: no seam, a fan-in of two or more feeds (so
 * the answer never depends on which feed sorts first), or a reversing seam.
 */
export function seamEndKind(
  stored: TileKindView,
  ownIn: number | null,
  ownOut: number | null,
  feeds: readonly number[],
  drain: number | null,
): TileKindView {
  // A fan-in keeps the authored kind whatever the feeds' order (side-load or merge).
  if (feeds.length >= 2) {
    return stored;
  }
  const feed = feeds.length === 1 ? feeds[0] : null;
  // No seam at this tile: nothing to derive.
  if (feed === null && drain === null) {
    return stored;
  }
  let e = feed ?? ownIn;
  let x = drain ?? ownOut;
  if (e === null && x === null) {
    return stored;
  }
  // A single tile with exactly one seam: that seam is both its entry and its exit.
  e ??= x;
  x ??= e;
  if (e === null || x === null) {
    return stored;
  }
  if (e === x && ownIn === null && ownOut === null) {
    // A single tile keeps its flow direction (D-15): a zero-turn corner, not a bare axis.
    return { Corner: { from: e, to: e } };
  }
  if (e === x) {
    return { Straight: { axis: travelAxis(e) } };
  }
  if (e === reverseDir(x)) {
    // A reversing seam: no command builds it, so it is never drawn as anything new.
    return stored;
  }
  return { Corner: { from: e, to: x } };
}

/**
 * A belt's tiles AS THE HOST WILL DRAW THEM once its pending docks land: `tiles` with
 * tiles[0] re-kinded by the Tail `feeds` and tiles[n-1] by the Head `drain`, composed
 * exactly as `effective_belt_tiles` composes them:
 *
 * - a multi-tile belt's own direction at the Tail is the step tiles[0] to tiles[1],
 *   and at the Head the step tiles[n-2] to tiles[n-1]; each end is judged alone, the
 *   Tail with the feeds and no drain, the Head with the drain and no feeds;
 * - a single tile has no own direction and takes both seams on its one tile.
 *
 * The caller passes only partners that will meet the end (the preview's predicted
 * docks); the host's "a partner that does not meet the tile keeps the stored kind"
 * rule is the caller's prediction, not a term here. Returns NEW tile objects for the
 * re-kinded ends and never mutates `tiles`.
 */
export function seamEndTiles(
  tiles: readonly TileView[],
  feeds: readonly number[],
  drain: number | null,
): TileView[] {
  const out = tiles.map((t) => ({ ...t }));
  const n = out.length;
  if (n === 0) {
    return out;
  }
  if (n === 1) {
    out[0].kind = seamEndKind(out[0].kind, null, null, feeds, drain);
    return out;
  }
  const own = (a: TileView, b: TileView): number | null =>
    sideOfUnitDelta([b.cell_x - a.cell_x, b.cell_y - a.cell_y]);
  const tailOwn = own(out[0], out[1]);
  if (tailOwn !== null) {
    out[0].kind = seamEndKind(out[0].kind, tailOwn, tailOwn, feeds, null);
  }
  const headOwn = own(out[n - 2], out[n - 1]);
  if (headOwn !== null) {
    out[n - 1].kind = seamEndKind(out[n - 1].kind, headOwn, headOwn, [], drain);
  }
  return out;
}
