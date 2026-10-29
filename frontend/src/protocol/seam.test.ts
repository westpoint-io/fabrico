import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PostcardReader, type TileKindView, type TileView } from './decode.ts';
import { route } from './route.ts';
import { seamEndKind, seamEndTiles } from './seam.ts';

// ---------------------------------------------------------------------------
// The seam table in TypeScript (phase 74.1 plan 08). `seamEndKind` is a 1:1 port of
// Rust `seam_end_kind` (crates/fabrico-core/src/state.rs), and the first describe block
// states the table by hand; the second holds it to the Rust answers frozen in
// `crates/fabrico-command/tests/fixtures/seam.bin` by `seam_golden.rs`, case by case.
// Dir N=0 E=1 S=2 W=3, Axis X=0 Y=1.
// ---------------------------------------------------------------------------

const STRAIGHT_X: TileKindView = { Straight: { axis: 0 } };
const STRAIGHT_Y: TileKindView = { Straight: { axis: 1 } };
const axisOf = (d: number): number => (d === 1 || d === 3 ? 0 : 1);

describe('seamEndKind: the seam table, stated by hand', () => {
  it('S1: a Tail fed from the E whose own out is N draws Corner{from:E,to:N}', () => {
    expect(seamEndKind(STRAIGHT_Y, null, 0, [1], null)).toEqual({ Corner: { from: 1, to: 0 } });
  });

  it('a Tail with one feed: Straight when it agrees, stored when it reverses, a corner otherwise', () => {
    for (const stored of [STRAIGHT_X, STRAIGHT_Y]) {
      for (let d = 0; d < 4; d++) {
        for (let s = 0; s < 4; s++) {
          const got = seamEndKind(stored, d, d, [s], null);
          if (s === d) {
            expect(got, `own ${d} feed ${s}`).toEqual({ Straight: { axis: axisOf(d) } });
          } else if (s === (d + 2) % 4) {
            // The SAME object back, not a copy that happens to be equal.
            expect(got, `own ${d} feed ${s}`).toBe(stored);
          } else {
            expect(got, `own ${d} feed ${s}`).toEqual({ Corner: { from: s, to: d } });
          }
        }
      }
    }
  });

  it('a Head with one drain: Straight, stored or Corner{from:own,to:drain} on the same split', () => {
    for (const stored of [STRAIGHT_X, STRAIGHT_Y]) {
      for (let d = 0; d < 4; d++) {
        for (let s = 0; s < 4; s++) {
          const got = seamEndKind(stored, d, d, [], s);
          if (s === d) {
            expect(got).toEqual({ Straight: { axis: axisOf(d) } });
          } else if (s === (d + 2) % 4) {
            expect(got).toBe(stored);
          } else {
            expect(got).toEqual({ Corner: { from: d, to: s } });
          }
        }
      }
    }
  });

  it('two feeds keep the stored kind in either order (a side-load or a merge)', () => {
    expect(seamEndKind(STRAIGHT_Y, 0, 0, [0, 1], null)).toBe(STRAIGHT_Y);
    expect(seamEndKind(STRAIGHT_Y, 0, 0, [1, 0], null)).toBe(STRAIGHT_Y);
    expect(seamEndKind(STRAIGHT_X, 1, 1, [0, 2], null)).toBe(STRAIGHT_X);
  });

  it('no seam keeps the stored kind, a corner included', () => {
    const c: TileKindView = { Corner: { from: 1, to: 2 } };
    expect(seamEndKind(c, 2, 2, [], null)).toBe(c);
    expect(seamEndKind(c, null, null, [], null)).toBe(c);
  });

  it('a single tile takes both seams: feeds [S] and drain E is Corner{from:S,to:E}', () => {
    expect(seamEndKind(STRAIGHT_X, null, null, [2], 1)).toEqual({ Corner: { from: 2, to: 1 } });
    // One seam only: that seam is both its entry and its exit, and the tile keeps its flow
    // direction as a zero-turn corner (phase 89, D-15), not a bare axis.
    expect(seamEndKind(STRAIGHT_X, null, null, [2], null)).toEqual({ Corner: { from: 2, to: 2 } });
    expect(seamEndKind(STRAIGHT_Y, null, null, [], 3)).toEqual({ Corner: { from: 3, to: 3 } });
    // A multi-tile end whose seam agrees with its own direction stays Straight.
    expect(seamEndKind(STRAIGHT_Y, 0, 0, [0], null)).toEqual(STRAIGHT_Y);
    expect(seamEndKind(STRAIGHT_X, 3, 3, [], 3)).toEqual(STRAIGHT_X);
  });

  // Phase 89 red-first probe (plan 89-01, D-01), seen failing at PHASE89_START and turned on by
  // plan 89-03 (its gate and title suffix removed; the body is unchanged).

  it(
    'a_one_tile_belt_fed_and_drained_west_keeps_its_west_flow',
    () => {
      // BELT-10 (D-15): a single tile (no own in or out) fed West and drained West keeps its flow
      // as a zero-turn corner, Corner{from: W, to: W}; Straight on the X axis loses it, and both
      // renderers then draw it flowing East.
      const got = seamEndKind(STRAIGHT_X, null, null, [3], 3);
      console.log(`P89-BELT-10-seam kind=${JSON.stringify(got)}`);
      expect(got, 'a one-tile West belt keeps its West flow').toEqual({ Corner: { from: 3, to: 3 } });
    },
  );
});

describe('seamEndTiles: the end-tile composition, as effective_belt_tiles composes it', () => {
  const routed = (cells: Array<[number, number]>): TileView[] => {
    const r = route(cells);
    if (!r.ok) {
      throw new Error('fixture path must route');
    }
    return r.tiles;
  };

  it('re-kinds tiles[0] from the feed and tiles[n-1] from the drain, never the interior', () => {
    // North from (4,0): fed from the W (travel E), draining E into an In at the top.
    const tiles = routed([
      [4, 0],
      [4, -1],
      [4, -2],
    ]);
    const before = JSON.stringify(tiles);
    const out = seamEndTiles(tiles, [1], 1);
    expect(out.map((t) => t.kind)).toEqual([
      { Corner: { from: 1, to: 0 } },
      STRAIGHT_Y,
      { Corner: { from: 0, to: 1 } },
    ]);
    expect(out.map((t) => [t.cell_x, t.cell_y])).toEqual([
      [4, 0],
      [4, -1],
      [4, -2],
    ]);
    // NEW tile objects; the input is never mutated.
    expect(JSON.stringify(tiles)).toBe(before);
    expect(out[0]).not.toBe(tiles[0]);
  });

  it('no feed and no drain returns the routed kinds unchanged', () => {
    const tiles = routed([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
    expect(seamEndTiles(tiles, [], null)).toEqual(tiles);
  });

  it('a single tile takes both seams on its one tile', () => {
    const tiles = routed([[3, 5]]);
    expect(seamEndTiles(tiles, [1], 2)[0].kind).toEqual({ Corner: { from: 1, to: 2 } });
    expect(seamEndTiles(tiles, [2], null)[0].kind).toEqual({ Corner: { from: 2, to: 2 } });
  });

  it('an empty path stays empty', () => {
    expect(seamEndTiles([], [1], 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cross-language parity. The Rust `freeze_seam` wrote every enumerated case with
// its `seam_end_kind` answer; each is decoded here and `seamEndKind` must agree.
// ---------------------------------------------------------------------------

/** The same literal `seam_golden.rs` asserts as `SEAM_CASE_COUNT`. */
const SEAM_CASE_COUNT = 490;

const fixtureUrl = (name: string) =>
  fileURLToPath(
    new URL(`../../../crates/fabrico-command/tests/fixtures/${name}`, import.meta.url),
  );

interface SeamCase {
  stored: TileKindView;
  ownIn: number | null;
  ownOut: number | null;
  feeds: number[];
  drain: number | null;
  answer: TileKindView;
}

/** `[tag, a, b]`: tag 0 = Straight{axis: a}, tag 1 = Corner{from: a, to: b}. */
function readKind(r: PostcardReader): TileKindView {
  const tag = r.u8();
  const a = r.u8();
  const b = r.u8();
  if (tag === 0) {
    return { Straight: { axis: a } };
  }
  if (tag === 1) {
    return { Corner: { from: a, to: b } };
  }
  throw new Error(`unexpected kind tag ${tag} in seam.bin`);
}

function readOptDir(r: PostcardReader): number | null {
  return r.u8() === 0 ? null : r.u8();
}

function decodeSeamGolden(bytes: Uint8Array): SeamCase[] {
  const r = new PostcardReader(bytes);
  const cases = r.vec<SeamCase>(() => ({
    stored: readKind(r),
    ownIn: readOptDir(r),
    ownOut: readOptDir(r),
    feeds: r.vec(() => r.u8()),
    drain: readOptDir(r),
    answer: readKind(r),
  }));
  expect(r.remaining(), 'the whole of seam.bin was consumed').toBe(0);
  return cases;
}

describe('seamEndKind: pinned to the Rust seam table (seam.bin, 74.1-08)', () => {
  const cases = decodeSeamGolden(new Uint8Array(readFileSync(fixtureUrl('seam.bin'))));

  it('reads exactly the case count the Rust freezer wrote', () => {
    expect(cases).toHaveLength(SEAM_CASE_COUNT);
  });

  it('agrees with seam_end_kind on every frozen case', () => {
    const mismatches: string[] = [];
    for (const [i, c] of cases.entries()) {
      const got = seamEndKind(c.stored, c.ownIn, c.ownOut, c.feeds, c.drain);
      if (JSON.stringify(got) !== JSON.stringify(c.answer)) {
        mismatches.push(
          `case ${i}: stored ${JSON.stringify(c.stored)} own ${c.ownIn}/${c.ownOut} ` +
            `feeds [${c.feeds}] drain ${c.drain}: rust ${JSON.stringify(c.answer)}, ts ${JSON.stringify(got)}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('NON-VACUITY: the frozen answers include corners, straights from a seam, and kept kinds', () => {
    const corners = cases.filter((c) => 'Corner' in c.answer && 'Straight' in c.stored).length;
    const fanIns = cases.filter((c) => c.feeds.length === 2).length;
    const kept = cases.filter((c) => JSON.stringify(c.answer) === JSON.stringify(c.stored)).length;
    expect(corners).toBeGreaterThan(0);
    expect(fanIns).toBe(16 * 8 + 16 * 10);
    expect(kept).toBeGreaterThan(0);
    // S1 is in the frozen set with the answer the hand-stated case above gives.
    const s1 = cases.find(
      (c) =>
        c.ownIn === 0 &&
        c.drain === null &&
        c.feeds.length === 1 &&
        c.feeds[0] === 1 &&
        JSON.stringify(c.stored) === JSON.stringify(STRAIGHT_Y),
    );
    expect(s1?.answer).toEqual({ Corner: { from: 1, to: 0 } });
  });
});
