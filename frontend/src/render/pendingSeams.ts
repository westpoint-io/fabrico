/**
 * THE PREDICTED SEAM OF A JUST-DRAWN BELT (phase 74.1 plan 20, review WR-05).
 *
 * WHY THIS EXISTS. A belt drawn from a port or a belt end that turns at once ships its
 * corner only once its Dock has folded: the host derives a docked end's kind at read
 * time (`effective_belt_tiles`), and until the link exists the packet carries route()'s
 * stored Straight at the seam. The Dock cannot ride the DrawBelt (the belt's handle does
 * not exist until the DrawBelt echoes), so the gesture layer sends it a frame or more
 * later from `watchBeltFollowUp`. The preview showed the corner up to the release and
 * clears AT the release, so for the two or three frames between the release and the Dock
 * echo the new belt was drawn with the T the maintainers rejected at S2 (74.1-SEAM-DESIGN section 5
 * promised it would not be).
 *
 * WHAT IT HOLDS. One record PER COMMITTED BELT still waiting on a dock (plan 74.1-30,
 * PAUSE-SECOND-DRAW; until then at most one, so a second belt drawn while paused wiped
 * the first one's prediction): the committed cells, the tiles the release pictured for it
 * (the same `seamEndTiles` answer as its held picture), which ends expect a dock, the
 * scene tick of the release, the follow-up's tick TTL and the DrawBelt's gesture id. The belts layer asks
 * {@link pendingSeamTiles} for each belt it draws and, while that belt's record answers,
 * draws the prediction in place of `belt.tiles`. Records are independent: each is found
 * by its own exact cells and ends on its own resolution, its own verdict or its fallback.
 *
 * RENDER-ONLY, BY CONSTRUCTION. Nothing in `src/protocol/`, `src/transport/` or the
 * scene decode path reads this module, so `window.__fabrico.scene()` and every model the
 * live oracle reads stay the host's truth. The answer is a NEW array; the belt passed in
 * is never mutated.
 *
 * WHEN THE PREDICTION DIES, and each is the reason it cannot outlive the truth:
 *
 * 1. THE DOCK ECHO. Every expected end now carries a dock in the packet, whose own
 *    derived kind is the truth: the record clears on that read. An end whose dock has
 *    landed reads the packet even while the other end is still pending.
 * 2. ITS OWN VERDICT (phase 88, D-06). The gesture layer ends a record by its owner, the
 *    DrawBelt's gesture id ({@link endPendingSeams}), when the DrawBelt is refused or
 *    discarded, when its follow-up ends with no Dock sent, and when one of the Docks it
 *    sent is refused or discarded: the belt genuinely is not joined at that end, so the
 *    stored Straight is the truth.
 * 3. THE FALLBACK. A Dock whose verdict never comes never echoes either. Once the board
 *    has run `ttlTicks` PLAYING ticks past `tick` (the follow-up watcher's own
 *    `ECHO_TTL_TICKS`, passed in by the gesture layer so there is one constant) the record
 *    clears. Only playing ticks count (phase 88, D-07): a paused board still drains ticks
 *    with input held, so a record is never dropped while paused, and the gesture layer's
 *    Resume restarts the count ({@link resumePendingSeams}). Until phase 88 every tick
 *    counted, and a draw released early in a long drain lost its corner before Play.
 * 4. TEARDOWN. The gesture layer clears every record when it is destroyed. A keyframe no
 *    longer clears them (phase 88): the follow-up survives an Undo and docks the belt
 *    anyway, and its record has to survive with it.
 * 5. A NEW DRAW WITH EXACTLY THE SAME CELLS replaces that cell list's record. A draw on
 *    other cells leaves it alone (74.1-30).
 *
 * Matching is by EXACT cell equality, the rule the follow-up watcher uses to find the
 * echoed belt: occupancy forbids a second belt on the same cells.
 */
import type { BeltEnd, BeltView, TileView } from '../protocol/decode';

export interface PendingSeamRecord {
  /** The committed cells, tail to head, exactly as the DrawBelt sent them. */
  readonly cells: ReadonlyArray<readonly [number, number]>;
  /** The predicted tiles, index-aligned with `cells` (the preview's seam kinds). */
  readonly tiles: readonly TileView[];
  /** Which ends the release armed a follow-up Dock for. */
  readonly expect: { readonly Tail: boolean; readonly Head: boolean };
  /** The scene tick at the release, or at the last Resume since ({@link resumePendingSeams}). */
  readonly tick: number;
  /** The follow-up's tick TTL: `ttlTicks` playing ticks past `tick`, the prediction expires. */
  readonly ttlTicks: number;
  /**
   * The gesture id of the DrawBelt this record predicts for (phase 88, D-06), the key
   * {@link endPendingSeams} ends it by. Absent, only the fallback, resolution, a same-cells
   * replacement or teardown ends it.
   */
  readonly owner?: number;
}

let records: PendingSeamRecord[] = [];

/**
 * Whether the board is playing, as the gesture layer reads it (phase 88, D-07), registered by
 * the gesture controller ({@link setPendingSeamsPlayState}). Absent, playing: a reader with no
 * controller behind it keeps the old count.
 */
let playState: (() => boolean) | null = null;

/**
 * Register the play-state read the fallback consults (phase 88, D-07): the gesture controller
 * passes its own `isPlaying` when it is created and `null` when it is destroyed. The belts
 * layer then reads the play state at read time without carrying it.
 */
export function setPendingSeamsPlayState(isPlaying: (() => boolean) | null): void {
  playState = isPlaying;
}

/**
 * The board resumed at `tick` (phase 88, D-07): every record's fallback count restarts there,
 * as `resumePortEdit` does for a port edit, because the ticks a pause drained ran with input
 * held and none of them is evidence a Dock was refused.
 */
export function resumePendingSeams(tick: number): void {
  if (records.length > 0) {
    records = records.map((r) => ({ ...r, tick }));
  }
}

/**
 * End every record whose owner is `owner` (phase 88, D-06): its DrawBelt or one of its Docks
 * was answered with a refusal or a discard, or its follow-up ended with nothing sent. A record
 * a later draw on the same cells replaced is that draw's, so it is not touched.
 */
export function endPendingSeams(owner: number): void {
  if (records.some((r) => r.owner === owner)) {
    records = records.filter((r) => r.owner !== owner);
  }
}

/** Whether a record's cells are exactly `cells`, in order. */
const sameCells = (
  a: ReadonlyArray<readonly [number, number]>,
  b: ReadonlyArray<readonly [number, number]>,
): boolean => a.length === b.length && a.every((c, i) => c[0] === b[i][0] && c[1] === b[i][1]);

/**
 * Record the prediction for a belt just released, replacing only a record with exactly
 * the same cells. A record that expects no dock is not stored (and still replaces one on
 * the same cells): with no dock coming there is nothing to wait for, and the packet's own
 * kinds are already final.
 */
export function recordPendingSeams(r: PendingSeamRecord): void {
  records = records.filter((x) => !sameCells(x.cells, r.cells));
  if (r.expect.Tail || r.expect.Head) {
    records.push(r);
  }
}

/** Drop every record (teardown). Idempotent. */
export function clearPendingSeams(): void {
  records = [];
}

/** The most recent record, read-only, for the gesture layer's tests; null when none. */
export function pendingSeamsRecord(): PendingSeamRecord | null {
  return records.length > 0 ? records[records.length - 1] : null;
}

/** Every record, oldest first, read-only, for the gesture layer's tests. */
export function pendingSeamsRecords(): readonly PendingSeamRecord[] {
  return [...records];
}

const hasDock = (belt: BeltView, end: BeltEnd): boolean => belt.docks.some((d) => d.end === end);

/**
 * The tiles to DRAW `belt` with at scene tick `tick`, or null to draw `belt.tiles`.
 *
 * Answers only for a belt whose cells equal a record's exactly, while that record's
 * fallback has not run out and at least one of its expected ends has no dock yet. The
 * middle tiles and any end whose dock has landed come from the packet; a pending end takes
 * the predicted kind. While `playing`, drops every record more than its `ttlTicks` past its
 * `tick`; while paused, drops none (phase 88, D-07). Drops the matched record on its
 * resolution (see the module docblock); no other record is touched. `playing` defaults to
 * the registered play-state read ({@link setPendingSeamsPlayState}).
 */
export function pendingSeamTiles(belt: BeltView, tick: number, playing: boolean = playState?.() ?? true): TileView[] | null {
  if (records.length === 0) {
    return null;
  }
  if (playing && records.some((x) => tick > x.tick + x.ttlTicks)) {
    records = records.filter((x) => tick <= x.tick + x.ttlTicks);
  }
  const n = belt.tiles.length;
  if (n === 0) {
    return null;
  }
  const r = records.find(
    (x) =>
      x.cells.length === n &&
      x.tiles.length === n &&
      x.cells.every((c, i) => belt.tiles[i].cell_x === c[0] && belt.tiles[i].cell_y === c[1]),
  );
  if (!r) {
    return null;
  }
  const tailPending = r.expect.Tail && !hasDock(belt, 'Tail');
  const headPending = r.expect.Head && !hasDock(belt, 'Head');
  if (!tailPending && !headPending) {
    records = records.filter((x) => x !== r);
    return null;
  }
  const out = belt.tiles.map((t) => ({ ...t }));
  if (n === 1) {
    out[0].kind = r.tiles[0].kind;
    return out;
  }
  if (tailPending) {
    out[0].kind = r.tiles[0].kind;
  }
  if (headPending) {
    out[n - 1].kind = r.tiles[n - 1].kind;
  }
  return out;
}
