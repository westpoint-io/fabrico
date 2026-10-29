// itemFrames.ts - the PURE grader of the DRAWN items against the model, frame by frame, at the
// tick each frame was drawn FROM (plan 77-04, phase 77 D-04, the 77-04 review blocker). Plain data
// in, plain data out. It imports NOTHING, so it carries no product source and no Playwright, and
// `src/gates/itemFrames.test.ts` grades every rule here on hand-written traces.
//
// ===========================================================================
// WHY THE DRAWN TICK, AND NOT THE TICK OF THE READ
// ===========================================================================
//
// The scene model is updated as each render packet lands (`App.tsx` `applyPacket`). The item
// layer places its dots only inside its `draw`, which the render loop calls once per display
// frame, and item interpolation is OFF by default (`ITEM_INTERPOLATION_DEFAULT`). So a sample that
// reads the model and the dots in one breath can pair tick T's model with the dots drawn for T-1
// or earlier. On a PACKED, still belt that lag is invisible. On a FLOWING belt (leg 4: the run and
// the outlet at 2 ticks per slot, about 18 items) several items cross a tile edge on every advance
// tick, and the two per-cell maps disagree on a correct build. Plan 77-07 met the same lag on the
// load gauge (measured up to 4 ticks, median 1) and keyed every gauge form by its drawn tick.
//
// This module does the same for the items. The in-page tick recorder (`oracle.ts`
// `startTickRecorder` with `itemDots`) copies the model on every new tick and, beside it, the
// latest drawn frame (`ItemLayer.plottedDotsFrame`: the dots and the `scene.tick` they were drawn
// from). A frame is graded against the RECORD OF ITS DRAWN TICK, never against the record that
// carried it. A frame whose drawn tick the recorder missed is set aside as UNALIGNED, never graded
// against a neighbour.
//
// ===========================================================================
// HOW A SLOT BECOMES A CELL
// ===========================================================================
//
// A belt with T tiles carries 4T slots, slot 0 at the HEAD. Counted from the tail, occupied slot s
// lies in tile `floor((4T - 1 - s) / 4)` (`frontend/src/render/interp.ts` `slotArcLength`, the
// `fromTail` arithmetic; the composed walk's `modelItemsPerCell`). The scene lists a belt's tiles
// TAIL FIRST, which leg 2 of the composed walk reads once (`TILES LIST TAIL FIRST`). A drawn dot
// goes to the cell containing it, `floor(coord / CELL)`: a slot's dot sits at `(m + 0.5) / 4` of
// its tile's flow, so no dot sits on a tile edge (`oracle.ts` `itemDotsPerCell`).

/** One drawn frame: the dot positions in world px and the scene tick they were drawn from
 *  (`null` when the layer had not drawn yet). */
export interface DrawnItemFrame {
  drawnAtTick: number | null;
  dots: readonly (readonly [number, number])[];
}

/** One recorder record, as much of it as this grader reads: the tick, every belt
 *  `[id, ticksPerSlot, occupiedSlots, docks]`, and the drawn frame read beside it. */
export interface ItemFrameRecord {
  t: number;
  belts: readonly (readonly [number, number, readonly number[], unknown])[];
  d?: DrawnItemFrame;
}

/** A belt whose items are graded, with its cells TAIL FIRST. */
export interface WatchedBelt {
  id: number;
  cells: readonly (readonly [number, number])[];
}

/** Four item slots per belt tile (`fabrico_core` `SLOTS_PER_TILE`). */
const SLOTS_PER_TILE = 4;

const key = (x: number, y: number): string => `${x},${y}`;

/** Every watched cell at 0. */
function emptyMap(watched: readonly WatchedBelt[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of watched) for (const [x, y] of b.cells) out[key(x, y)] = 0;
  return out;
}

/** The MODEL's items per watched cell in one record, every watched cell present. */
export function modelItemsPerCell(
  record: ItemFrameRecord,
  watched: readonly WatchedBelt[],
): Record<string, number> {
  const out = emptyMap(watched);
  for (const b of watched) {
    const slots = record.belts.find((x) => x[0] === b.id)?.[2] ?? [];
    const total = b.cells.length * SLOTS_PER_TILE;
    for (const s of slots) {
      const cell = b.cells[Math.floor((total - 1 - s) / SLOTS_PER_TILE)];
      if (cell === undefined) continue;
      out[key(cell[0], cell[1])] += 1;
    }
  }
  return out;
}

/** The DRAWN dots per watched cell, every watched cell present; dots elsewhere ignored. */
export function drawnItemsPerCell(
  dots: readonly (readonly [number, number])[],
  watched: readonly WatchedBelt[],
  cellPx: number,
): Record<string, number> {
  const out = emptyMap(watched);
  for (const [x, y] of dots) {
    const k = key(Math.floor(x / cellPx), Math.floor(y / cellPx));
    if (k in out) out[k] += 1;
  }
  return out;
}

/** The dots on the watched cells, rounded to 1 px and sorted, as one comparable string. */
function drawnSet(
  dots: readonly (readonly [number, number])[],
  watched: readonly WatchedBelt[],
  cellPx: number,
): string {
  const cells = emptyMap(watched);
  return JSON.stringify(
    dots
      .filter(([x, y]) => key(Math.floor(x / cellPx), Math.floor(y / cellPx)) in cells)
      .map(([x, y]) => [Math.round(x), Math.round(y)])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]),
  );
}

function sameMap(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/** What {@link gradeDrawnItems} returns. */
export interface DrawnItemsGrade {
  /** Distinct drawn ticks carried by the records (each drawn tick once). */
  frames: number;
  /** Frames whose drawn tick has a record: the ones graded. */
  aligned: number;
  /** Frames whose drawn tick the recorder missed: set aside, never graded. */
  unaligned: number;
  /** Aligned frames whose drawn per-cell map equals the model's at the drawn tick. */
  matched: number;
  /** Matched frames whose model held at least one item on the watched cells. */
  matchedWithItems: number;
  /** Distinct drawn dot sets on the watched cells over the frames (rounded to 1 px). */
  distinctDrawn: number;
  /** Every aligned frame that did not match, with both maps. */
  mismatches: { drawnAtTick: number; drawn: Record<string, number>; model: Record<string, number> }[];
}

/**
 * Grade every drawn frame in `records` against the model of the tick it was drawn from. Each
 * drawn tick is graded ONCE (the first record carrying it). A record with no frame, or a frame
 * drawn before the layer's first draw (`drawnAtTick` null), adds nothing.
 */
export function gradeDrawnItems(
  records: readonly ItemFrameRecord[],
  watched: readonly WatchedBelt[],
  cellPx: number,
): DrawnItemsGrade {
  const byTick = new Map<number, ItemFrameRecord>();
  for (const r of records) if (!byTick.has(r.t)) byTick.set(r.t, r);
  const frames = new Map<number, DrawnItemFrame>();
  for (const r of records) {
    const f = r.d;
    if (f === undefined || f.drawnAtTick === null) continue;
    if (!frames.has(f.drawnAtTick)) frames.set(f.drawnAtTick, f);
  }
  const grade: DrawnItemsGrade = {
    frames: frames.size,
    aligned: 0,
    unaligned: 0,
    matched: 0,
    matchedWithItems: 0,
    distinctDrawn: 0,
    mismatches: [],
  };
  const sets = new Set<string>();
  for (const [tick, f] of [...frames.entries()].sort((a, b) => a[0] - b[0])) {
    sets.add(drawnSet(f.dots, watched, cellPx));
    const at = byTick.get(tick);
    if (at === undefined) {
      grade.unaligned += 1;
      continue;
    }
    grade.aligned += 1;
    const drawn = drawnItemsPerCell(f.dots, watched, cellPx);
    const model = modelItemsPerCell(at, watched);
    if (sameMap(drawn, model)) {
      grade.matched += 1;
      if (Object.values(model).some((n) => n > 0)) grade.matchedWithItems += 1;
    } else {
      grade.mismatches.push({ drawnAtTick: tick, drawn, model });
    }
  }
  grade.distinctDrawn = sets.size;
  return grade;
}

/** The log line a leg prints for a grade. */
export function drawnItemsLine(g: DrawnItemsGrade): string {
  const rate = g.aligned === 0 ? 0 : g.matched / g.aligned;
  return (
    `ITEM_FRAMES frames=${g.frames} aligned=${g.aligned} unaligned=${g.unaligned} matched=${g.matched} ` +
    `matchedWithItems=${g.matchedWithItems} distinct=${g.distinctDrawn} rate=${rate.toFixed(3)}`
  );
}
