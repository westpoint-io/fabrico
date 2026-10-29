import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PostcardReader, type TileView } from './decode.ts';
import { route } from './route.ts';

// route() is a 1:1 TS port of the pure Rust belt-path normalizer
// (crates/fabrico-command/src/route.rs). These unit cases pin the five
// behaviors the gesture-layer live preview (14-07) depends on; the golden
// cross-language pin lives in the second describe block below.
//
// Encoding (matches decode.ts TileKindView): axis X=0, Y=1; Dir N=0, E=1,
// S=2, W=3 — the SAME numeric shape the wire TileView carries, so the preview
// tiles and the committed tiles are one shape (BELT-03 preview==commit).

describe('route() — corner inference + typed rejection (port of route.rs)', () => {
  it('rejects an empty path with a typed Empty error (never a guess)', () => {
    expect(route([])).toEqual({ ok: false, error: 'Empty' });
  });

  it('rejects a >1-cell jump as NonAdjacent', () => {
    expect(route([[0, 0], [2, 0]])).toEqual({ ok: false, error: 'NonAdjacent' });
  });

  it('rejects a diagonal step as NonAdjacent', () => {
    expect(route([[0, 0], [1, 1]])).toEqual({ ok: false, error: 'NonAdjacent' });
  });

  it('rejects a path that repeats a cell as SelfCrossing', () => {
    // (0,0)->(1,0)->(1,1)->(0,1)->(0,0) closes a loop, repeating (0,0).
    expect(
      route([[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]),
    ).toEqual({ ok: false, error: 'SelfCrossing' });
  });

  it('infers the L-bend: Straight{X}, Corner{from:E,to:S}, Straight{Y}', () => {
    expect(route([[0, 0], [1, 0], [1, 1]])).toEqual({
      ok: true,
      tiles: [
        { cell_x: 0, cell_y: 0, kind: { Straight: { axis: 0 } } },
        { cell_x: 1, cell_y: 0, kind: { Corner: { from: 1, to: 2 } } },
        { cell_x: 1, cell_y: 1, kind: { Straight: { axis: 1 } } },
      ],
    });
  });

  it('routes a single-cell path to one Straight{X} tile (length-1 default)', () => {
    expect(route([[7, 7]])).toEqual({
      ok: true,
      tiles: [{ cell_x: 7, cell_y: 7, kind: { Straight: { axis: 0 } } }],
    });
  });

  it('routes a straight horizontal run to all Straight{X}', () => {
    const r = route([[0, 0], [1, 0], [2, 0], [3, 0]]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tiles.every((t) => 'Straight' in t.kind && t.kind.Straight.axis === 0)).toBe(true);
    expect(r.tiles.map((t) => [t.cell_x, t.cell_y])).toEqual([
      [0, 0], [1, 0], [2, 0], [3, 0],
    ]);
  });

  it('routes a straight vertical run to all Straight{Y}', () => {
    const r = route([[5, 0], [5, 1], [5, 2]]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tiles.every((t) => 'Straight' in t.kind && t.kind.Straight.axis === 1)).toBe(true);
  });

  it('covers all four perpendicular bends (E->N, N->W, W->S, S->E)', () => {
    const bend = (cells: [number, number][]) => {
      const r = route(cells);
      if (!r.ok) throw new Error('expected ok');
      return r.tiles[1].kind;
    };
    expect(bend([[0, 0], [1, 0], [1, -1]])).toEqual({ Corner: { from: 1, to: 0 } }); // E->N
    expect(bend([[0, 0], [0, -1], [-1, -1]])).toEqual({ Corner: { from: 0, to: 3 } }); // N->W
    expect(bend([[0, 0], [-1, 0], [-1, 1]])).toEqual({ Corner: { from: 3, to: 2 } }); // W->S
    expect(bend([[0, 0], [0, 1], [1, 1]])).toEqual({ Corner: { from: 2, to: 1 } }); // S->E
  });

  it('never throws on a rejected path — returns an ordinary result union', () => {
    expect(() => route([])).not.toThrow();
    expect(() => route([[0, 0], [9, 9]])).not.toThrow();
  });

  it('is deterministic — the same cells route to the same tiles every call', () => {
    const cells: [number, number][] = [[0, 0], [1, 0], [1, 1], [2, 1], [2, 2]];
    expect(route(cells)).toEqual(route(cells));
  });
});

// ---------------------------------------------------------------------------
// Cross-language golden pin (preview == commit, BELT-03). The Rust `route`
// golden was frozen in 14-02 (crates/fabrico-command/tests/fixtures/route.*)
// from the canonical L-bend cells [(0,0),(1,0),(1,1)]. The TS port MUST produce
// shape-identical tiles for the SAME input, or this fails CI — the same
// discipline as the 0007 decoder pin. Resolving the fixture relative to THIS
// file keeps the path stable regardless of the vitest cwd.
// ---------------------------------------------------------------------------

const fixtureUrl = (name: string) =>
  fileURLToPath(
    new URL(`../../../crates/fabrico-command/tests/fixtures/${name}`, import.meta.url),
  );

// The exact cells the Rust `freeze_route` used to mint the golden.
const GOLDEN_CELLS: [number, number][] = [[0, 0], [1, 0], [1, 1]];

// Map the serde string enums in route.expected.json to the numeric encoding the
// TS TileView carries (axis X=0/Y=1, Dir N=0/E=1/S=2/W=3).
const AXIS: Record<string, number> = { X: 0, Y: 1 };
const DIR: Record<string, number> = { N: 0, E: 1, S: 2, W: 3 };

interface ExpectedTile {
  cell: [number, number];
  kind: { Straight: { axis: string } } | { Corner: { from: string; to: string } };
}

/**
 * Decode the committed `route.bin` (postcard `Vec<BeltTile>`) using the existing
 * exported PostcardReader. BeltTile's wire layout (cell.0, cell.1, kind
 * discriminant, payload) is byte-identical to the TileView grammar in decode.ts.
 */
function decodeRouteGolden(bytes: Uint8Array): TileView[] {
  const r = new PostcardReader(bytes);
  return r.vec<TileView>(() => {
    const cell_x = r.varintI();
    const cell_y = r.varintI();
    const disc = r.varintU();
    if (disc === 0) {
      return { cell_x, cell_y, kind: { Straight: { axis: r.u8() } } };
    }
    if (disc === 1) {
      return { cell_x, cell_y, kind: { Corner: { from: r.u8(), to: r.u8() } } };
    }
    throw new Error(`unexpected TileKind discriminant ${disc} in route.bin`);
  });
}

describe('route() — pinned to the cross-language Rust golden (14-02, BELT-03)', () => {
  it('produces tiles byte-parity-identical to the frozen route.bin', () => {
    const goldenBytes = new Uint8Array(readFileSync(fixtureUrl('route.bin')));
    const goldenTiles = decodeRouteGolden(goldenBytes);

    const r = route(GOLDEN_CELLS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Preview == commit: the TS port reproduces the Rust commit-path tiles.
    expect(r.tiles).toEqual(goldenTiles);
  });

  it('matches the readable route.expected.json shape (Straight{X}, Corner{E,S}, Straight{Y})', () => {
    const expected: ExpectedTile[] = JSON.parse(
      readFileSync(fixtureUrl('route.expected.json'), 'utf8'),
    );
    const expectedTiles: TileView[] = expected.map((t) => ({
      cell_x: t.cell[0],
      cell_y: t.cell[1],
      kind:
        'Straight' in t.kind
          ? { Straight: { axis: AXIS[t.kind.Straight.axis] } }
          : { Corner: { from: DIR[t.kind.Corner.from], to: DIR[t.kind.Corner.to] } },
    }));

    const r = route(GOLDEN_CELLS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tiles).toEqual(expectedTiles);
  });

  it('fails if corner inference diverges from the golden (preview==commit guard)', () => {
    // Sanity: the golden's middle tile is the Corner{E,S} bend, not a Straight.
    const goldenTiles = decodeRouteGolden(
      new Uint8Array(readFileSync(fixtureUrl('route.bin'))),
    );
    expect(goldenTiles[1].kind).toEqual({ Corner: { from: 1, to: 2 } });
    const r = route(GOLDEN_CELLS);
    if (!r.ok) throw new Error('expected ok');
    expect(r.tiles[1].kind).toEqual(goldenTiles[1].kind);
  });
});
