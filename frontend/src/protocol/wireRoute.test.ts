import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PostcardReader, type TileView } from './decode.ts';
import { nubAnchor } from './ports.ts';
import {
  type WireAnchor,
  type WireBody,
  type WireDock,
  type WireGeometry,
  CAND_AROUND_CROWDED,
  CAND_AROUND_MACHINES,
  CAND_CLEAR_OF_BODIES,
  CAND_FACE_ALIGNED,
  CAND_GO_AROUND,
  CAND_NONE,
  CAND_PERIMETER,
  cellBody,
  nodeIndexOf,
  perimeterCells,
  searchOnLines,
  wireRoute,
  wireRouteAvoidingTraced,
  wireRouteTraced,
} from './wireRoute.ts';

// wireRoute() is the TS mirror of the Rust `wire_route`
// (crates/fabrico-command/src/wire_route.rs, frozen in 40-01). The Rust router is
// AUTHORITATIVE; this file does NOT author a TS-only router — it re-derives the
// same endpoint->endpoint geometry and PINS it, value-for-value, to the frozen
// cross-language golden (wire.bin + wire.expected.json). Any path/anchor
// divergence fails CI (the v5.0 live-oracle lesson: vitest+tsc miss geometry
// drift, a cross-language golden does not — WUI-01 criterion 4, T-40-03-DRIFT).
//
// Encoding (matches decode.ts / route.test.ts): axis X=0, Y=1; Dir/Side N=0,
// E=1, S=2, W=3. The wire nub anchor (2.5px outward push) is a render-side FLOAT
// derived canvas-side from the pinned integer (cell, side) triple — never on the
// wire, never in this golden.

const fixtureUrl = (name: string) =>
  fileURLToPath(
    new URL(`../../../crates/fabrico-command/tests/fixtures/${name}`, import.meta.url),
  );

// The exact endpoints the Rust `freeze_wire` used to mint the golden: the
// canonical L — leave (0,0) eastward, bend south, enter (1,1) from the north.
const GOLDEN_FROM = { cell: [0, 0] as [number, number], side: 1, body: cellBody(0, 0) }; // E
const GOLDEN_TO = { cell: [1, 1] as [number, number], side: 0, body: cellBody(1, 1) }; // N

// Map the serde string enums in wire.expected.json to the numeric encoding the
// TS TileView carries (axis X=0/Y=1, Dir N=0/E=1/S=2/W=3).
const AXIS: Record<string, number> = { X: 0, Y: 1 };
const DIR: Record<string, number> = { N: 0, E: 1, S: 2, W: 3 };

interface ExpectedTile {
  cell: [number, number];
  kind: { Straight: { axis: string } } | { Corner: { from: string; to: string } };
}
interface ExpectedWire {
  from_anchor: WireAnchor;
  to_anchor: WireAnchor;
  tiles: ExpectedTile[];
}

/**
 * Decode the committed `wire.bin` (postcard `WireGeometry`) with the existing
 * exported PostcardReader. Field order MIRRORS the Rust struct: `from_anchor`
 * (cell_x varintI, cell_y varintI, side u8), `to_anchor` (same), then the
 * `Vec<BeltTile>` path (byte-identical to the TileView grammar in decode.ts).
 */
function decodeWireGolden(bytes: Uint8Array): WireGeometry {
  const r = new PostcardReader(bytes);
  const anchor = (): WireAnchor => ({
    cell_x: r.varintI(),
    cell_y: r.varintI(),
    side: r.u8(),
  });
  const from_anchor = anchor();
  const to_anchor = anchor();
  const tiles = r.vec<TileView>(() => {
    const cell_x = r.varintI();
    const cell_y = r.varintI();
    const disc = r.varintU();
    if (disc === 0) {
      return { cell_x, cell_y, kind: { Straight: { axis: r.u8() } } };
    }
    if (disc === 1) {
      return { cell_x, cell_y, kind: { Corner: { from: r.u8(), to: r.u8() } } };
    }
    throw new Error(`unexpected TileKind discriminant ${disc} in wire.bin`);
  });
  return { from_anchor, to_anchor, tiles };
}

describe('wireRoute() — pinned to the cross-language Rust golden (40-01, WUI-01)', () => {
  it('produces geometry byte-parity-identical to the frozen wire.bin', () => {
    const golden = decodeWireGolden(new Uint8Array(readFileSync(fixtureUrl('wire.bin'))));

    const r = wireRoute(GOLDEN_FROM, GOLDEN_TO);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Drawn == model: the TS mirror reproduces the Rust wire geometry exactly.
    expect(r.geometry).toEqual(golden);
  });

  it('matches the readable wire.expected.json shape (anchors + Straight{X},Corner{E,S},Straight{Y})', () => {
    const expected: ExpectedWire = JSON.parse(
      readFileSync(fixtureUrl('wire.expected.json'), 'utf8'),
    );
    const expectedTiles: TileView[] = expected.tiles.map((t) => ({
      cell_x: t.cell[0],
      cell_y: t.cell[1],
      kind:
        'Straight' in t.kind
          ? { Straight: { axis: AXIS[t.kind.Straight.axis] } }
          : { Corner: { from: DIR[t.kind.Corner.from], to: DIR[t.kind.Corner.to] } },
    }));

    const r = wireRoute(GOLDEN_FROM, GOLDEN_TO);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.geometry.from_anchor).toEqual(expected.from_anchor);
    expect(r.geometry.to_anchor).toEqual(expected.to_anchor);
    expect(r.geometry.tiles).toEqual(expectedTiles);
  });

  it('derives the electrical nub anchors from the pinned (cell, side) via the shared nubAnchor math', () => {
    // The float pixel anchor is render-side; the PINNED contract is the integer
    // (cell, side) triple. The TS mirror's anchors must equal the golden's, so
    // the SAME nubAnchor call lands the drawn terminal on the modelled cell/side.
    const golden = decodeWireGolden(new Uint8Array(readFileSync(fixtureUrl('wire.bin'))));
    const r = wireRoute(GOLDEN_FROM, GOLDEN_TO);
    if (!r.ok) throw new Error('expected ok');

    for (const key of ['from_anchor', 'to_anchor'] as const) {
      const mine = r.geometry[key];
      const theirs = golden[key];
      expect(mine).toEqual(theirs); // integer parity (cell + side)
      // The shared render-side math lands identically on both.
      expect(nubAnchor(mine.cell_x, mine.cell_y, mine.side)).toEqual(
        nubAnchor(theirs.cell_x, theirs.cell_y, theirs.side),
      );
    }
  });

  it('fails loudly if the corner inference diverges from the golden (drift guard)', () => {
    const golden = decodeWireGolden(new Uint8Array(readFileSync(fixtureUrl('wire.bin'))));
    // Sanity: the golden's middle tile is the Corner{E,S} bend, not a Straight.
    expect(golden.tiles[1].kind).toEqual({ Corner: { from: 1, to: 2 } });
    const r = wireRoute(GOLDEN_FROM, GOLDEN_TO);
    if (!r.ok) throw new Error('expected ok');
    expect(r.geometry.tiles[1].kind).toEqual(golden.tiles[1].kind);
  });
});

describe('wireRoute() — deterministic single-L auto-router (mirrors wire_route.rs)', () => {
  it('routes the canonical L to three tiles normalized through route()', () => {
    const r = wireRoute({ cell: [0, 0], side: 1, body: cellBody(0, 0) }, { cell: [1, 1], side: 0, body: cellBody(1, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.geometry.tiles.map((t) => [t.cell_x, t.cell_y])).toEqual([
      [0, 0], [1, 0], [1, 1],
    ]);
  });

  // DECLARED CHANGE (75-01). This was 'routes colinear endpoints to a straight run' and
  // pinned four straight X tiles (0,0)..(3,0). Both ports face E, so that run entered
  // the target's east-facing port from behind. The pair is in the one-face class, so it
  // now goes around, cell for cell the Rust inline test
  // `colinear_east_to_east_goes_around_into_the_target_face`.
  it('routes colinear east-to-east endpoints around the target, into its east face', () => {
    const r = wireRouteTraced({ cell: [0, 0], side: 1, body: cellBody(0, 0) }, { cell: [3, 0], side: 1, body: cellBody(3, 0) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cand).toBe(CAND_GO_AROUND);
    expect(r.geometry.tiles.map((t) => [t.cell_x, t.cell_y])).toEqual([
      [0, 0], [1, 0], [2, 0], [2, -1], [3, -1], [4, -1], [4, 0], [3, 0],
    ]);
  });

  // DECLARED INVERSION (75-03, CABLE-09 part 1). This was 'routes coincident endpoints to
  // a single cell' and pinned a one-tile ok. The Rust router refuses two docks on one cell
  // since 75-03 (`coincident_docks_are_a_typed_refusal`), and the preview copy must agree,
  // so the drag over the source's own cell still draws no corridor (UI-SPEC 2.3).
  it('coincident docks are a typed refusal in the mirror too', () => {
    const d: WireDock = { cell: [2, 2], side: 0, body: cellBody(2, 2) };
    expect(wireRoute(d, d)).toEqual({ ok: false, error: 'Coincident' });
    expect(wireRouteTraced(d, d)).toEqual({ ok: false, error: 'Coincident' });
  });

  it('is deterministic — the same docks route to the same geometry every call', () => {
    const a = wireRoute({ cell: [0, 0], side: 1, body: cellBody(0, 0) }, { cell: [2, 3], side: 0, body: cellBody(2, 3) });
    const b = wireRoute({ cell: [0, 0], side: 1, body: cellBody(0, 0) }, { cell: [2, 3], side: 0, body: cellBody(2, 3) });
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// THE 3920-PAIR CROSS-LANGUAGE PARITY CORPUS (phase 72, plans 15 and 16).
//
// The golden above pins ONE dock pair, (0,0)E -> (1,1)N. Under the face-aligned
// router that pair selects the plain X-first arm, so it exercises neither Z
// branch, nor the four-way selector, nor the perimeter ring: honest coverage of
// the shape it pins, and blind to every branch plans 15 and 16 added.
//
// This corpus is what makes the hand-mirrored copy in wireRoute.ts safe. It is
// frozen from the RUST side (crates/fabrico-command/tests/wire_corpus.rs, which
// is authoritative) and read here by relative path, the same mechanism the
// golden above already uses. One transposed component in the TS copy reddens it.
// Proved non-vacuous by mutation before it shipped, not assumed.
//
// EACH ROW CARRIES A RESOLVED BODY RECTANGLE PER END and the winning CANDIDATE.
// The 14 dock numbers are read as data and nothing here derives a rectangle from
// {w, h, rot}: that decode exists once per language, and putting a second copy
// in this file would defeat the reason the router takes a resolved rectangle at
// all. The `cand` column is what lets the TS half of G1 exist; see the it() that
// reads it.
// ---------------------------------------------------------------------------

interface CorpusRow {
  /**
   * `[from_x, from_y, from_side, from_body_min_x, from_body_min_y,
   * from_body_max_x, from_body_max_y, to_x, to_y, to_side, to_body_min_x,
   * to_body_min_y, to_body_max_x, to_body_max_y]`. RESOLVED rectangles.
   */
  docks: [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  /**
   * Which candidate won: 0 = perimeter ring, 1 = face-aligned, 2 = Manhattan L,
   * 3 = go-around, `CAND_NONE` (255) = the router refused the pair.
   */
  cand: number;
  /** The router's refusal, present only on the rows it refused (75-03): `'Coincident'`. */
  err?: string;
  /** `[cell_x, cell_y, kind, a, b]`; kind 0 = Straight (a = axis, b = -1), 1 = Corner. */
  tiles: [number, number, number, number, number][];
}

/** The two docks a corpus row describes, rebuilt from its own frozen numbers. */
function docksOf(row: CorpusRow): [WireDock, WireDock] {
  const d = row.docks;
  return [
    {
      cell: [d[0], d[1]],
      side: d[2],
      body: { min_x: d[3], min_y: d[4], max_x: d[5], max_y: d[6] },
    },
    {
      cell: [d[7], d[8]],
      side: d[9],
      body: { min_x: d[10], min_y: d[11], max_x: d[12], max_y: d[13] },
    },
  ];
}

describe('wireRoute cross-language parity corpus', () => {
  const rows: CorpusRow[] = JSON.parse(
    readFileSync(fixtureUrl('wire_corpus.expected.json'), 'utf8'),
  ) as CorpusRow[];

  it('reads a corpus of the expected shape', () => {
    // 5 machine-shape pairs x 4 source sides x 4 target sides x a 7x7 offset grid.
    expect(rows.length).toBe(5 * 4 * 4 * 7 * 7);
  });

  it('exercises the branches the single golden cannot reach', () => {
    // Without this the corpus could silently narrow to plain-L rows and keep
    // passing, which is the exact defect class it exists to prevent.
    const corners = (r: CorpusRow) => r.tiles.filter((t) => t[2] === 1).length;
    expect(rows.filter((r) => corners(r) === 2).length).toBeGreaterThan(0);
    expect(rows.filter((r) => corners(r) === 1).length).toBeGreaterThan(0);
    expect(rows.filter((r) => corners(r) === 0).length).toBeGreaterThan(0);
    // G6. The go-around shapes are 3 and 4 corners. Without this clause they can
    // vanish from the sweep entirely while the three counts above stay green,
    // because a plain L and a Z between them cover 0, 1 and 2.
    expect(rows.filter((r) => corners(r) >= 3).length).toBeGreaterThan(0);
  });

  // G1, TS HALF. The Rust half lives in wire_corpus.rs.
  //
  // wireRoute() swallows a route() rejection of the ring candidate and quietly
  // serves the face-aligned shape instead. So a TS mirror whose perimeterCells
  // declined everywhere, or fired everywhere, would still produce the frozen
  // tiles on every row where the fall-through happens to agree, and the parity
  // test below would pass over a mirror that does not mirror. This calls
  // perimeterCells DIRECTLY and pins it, row by row, against what the Rust
  // ladder actually did.
  //
  // OBSERVED REDDENING, and the numbers are the argument for this test existing.
  // Dropping `arriveY` from the TS D2 gate (run, observed, reverted) reddens
  // THIS test on 450 of 3920 rows and the tile-parity test below on 360. The
  // 90-row gap is the fall-through: rows where the TS mirror fired a ring Rust
  // did not, route() then rejected or the shapes happened to coincide, and the
  // emitted tiles came out identical anyway. Without this test those 90 rows are
  // a mirror that has stopped mirroring, passing green.
  it('the TS perimeterCells fires on exactly the rows the Rust ring won', () => {
    const mismatches: string[] = [];
    for (const row of rows) {
      const [from, to] = docksOf(row);
      const fired = perimeterCells(from, to) !== null;
      const rustWon = row.cand === 0;
      if (fired !== rustWon) {
        mismatches.push(
          `docks ${JSON.stringify(row.docks)}: rust cand=${row.cand}, TS perimeterCells ${
            fired ? 'FIRED' : 'declined'
          }`,
        );
      }
    }
    expect(
      mismatches.slice(0, 5).join('\n'),
      `${mismatches.length} of ${rows.length} rows disagree on which candidate fires`,
    ).toBe('');
  });

  // THE CANDIDATE COLUMN, TS SIDE (75-01). The tile parity test below cannot see a
  // TS ladder that served the right tiles from the WRONG arm (a go-around search that
  // declined where Rust's fired, on a row where the two shapes happen to coincide), and
  // the perimeterCells test above sees only the ring. This reads which candidate the TS
  // ladder used on every row through `wireRouteTraced`, the function `wireRoute`
  // delegates to, and pins it to the Rust `cand` column.
  //
  // OBSERVED (75-01): red on 1,440 of 3,920 rows after the re-bless and before the
  // mirror landed (the tile parity test below was red on the same 1,440). Dropping one
  // line (`qx0 - 1`) from the TS line set alone reddens the tile parity test on 71 rows
  // and leaves this one green: the search still finds a path there, a different one.
  // THE CANDIDATE COLUMN COVERS EVERY ARM THE CORPUS CAN REACH (75-03). Without this the
  // equality test below could pass on a corpus that silently lost a whole candidate: the
  // ring (0), the face-aligned shape (1), the go-around (3), clear of bodies (4) and the
  // refusal sentinel `CAND_NONE` must each win at least one row. (2, the Manhattan L, is
  // unreachable by proof and is deliberately absent.)
  it('the corpus carries candidates 0, 1, 3, 4 and the refusal sentinel', () => {
    const seen = new Set(rows.map((r) => r.cand));
    for (const c of [CAND_PERIMETER, CAND_FACE_ALIGNED, CAND_GO_AROUND, CAND_CLEAR_OF_BODIES, CAND_NONE]) {
      expect(seen.has(c), `no corpus row has cand ${c}`).toBe(true);
    }
    expect(rows.filter((r) => r.cand === CAND_CLEAR_OF_BODIES).length, 'the cand-4 pin').toBe(208);
  });

  it('the TS candidate equals the Rust cand on every corpus row', () => {
    const mismatches: string[] = [];
    for (const row of rows) {
      const [from, to] = docksOf(row);
      const r = wireRouteTraced(from, to);
      const cand = r.ok ? r.cand : CAND_NONE;
      if (cand !== row.cand) {
        mismatches.push(`docks ${JSON.stringify(row.docks)}: rust cand=${row.cand}, TS cand=${cand}`);
      }
    }
    expect(
      mismatches.slice(0, 5).join('\n'),
      `${mismatches.length} of ${rows.length} rows disagree on which candidate drew the cable`,
    ).toBe('');
  });

  // THE ERROR ROWS (75-03, D-05). The Rust freezer writes `err` on exactly the rows its
  // router refused; the mirror must refuse exactly those, with the same name, and route
  // every other row. Red against the pre-75-03 mirror on all 80 coincident rows.
  it('the TS mirror refuses exactly the corpus error rows, with the same error', () => {
    const errRows = rows.filter((r) => r.err !== undefined);
    expect(errRows.length, 'the 80 coincident rows are the error rows').toBe(80);
    const mismatches: string[] = [];
    for (const row of rows) {
      const [from, to] = docksOf(row);
      const r = wireRoute(from, to);
      const got = r.ok ? undefined : r.error;
      if (got !== row.err) {
        mismatches.push(`docks ${JSON.stringify(row.docks)}: rust err=${row.err}, TS err=${got}`);
      }
    }
    expect(
      mismatches.slice(0, 5).join('\n'),
      `${mismatches.length} of ${rows.length} rows disagree on the refusal`,
    ).toBe('');
  });

  it('the TS mirror is tile-for-tile identical to the Rust router on all 3920 pairs', () => {
    const mismatches: string[] = [];
    for (const row of rows) {
      const [from, to] = docksOf(row);
      const r = wireRoute(from, to);
      if (row.err !== undefined) {
        // An error row has no tiles; the refusal itself is the test above.
        if (r.ok || row.tiles.length !== 0) {
          mismatches.push(`docks ${JSON.stringify(row.docks)}: an error row the TS mirror routed`);
        }
        continue;
      }
      if (!r.ok) {
        mismatches.push(
          `docks ${JSON.stringify(row.docks)}: TS mirror REJECTED a pair Rust routed`,
        );
        continue;
      }
      const got = r.geometry.tiles.map((t) =>
        'Straight' in t.kind
          ? [t.cell_x, t.cell_y, 0, t.kind.Straight.axis, -1]
          : [t.cell_x, t.cell_y, 1, t.kind.Corner.from, t.kind.Corner.to],
      );
      if (JSON.stringify(got) !== JSON.stringify(row.tiles)) {
        mismatches.push(
          `docks ${JSON.stringify(row.docks)}\n  rust: ${JSON.stringify(row.tiles)}\n  ts:   ${JSON.stringify(got)}`,
        );
      }
    }
    expect(
      mismatches.slice(0, 5).join('\n'),
      `${mismatches.length} of ${rows.length} pairs diverged`,
    ).toBe('');
  });
});

// CABLE-04, the TypeScript half (plan 75-02). `wire_side_aware.expected.json` is HAND-WRITTEN
// (no freezer writes it; its rule is in its own `note` field and in `wire_golden.rs`), and
// `wire_golden.rs::side_aware_cases_match_the_hand_written_literals` asserts the Rust router
// reproduces it. This asserts the preview copy does too, from the same file, cell values
// compared as numbers. Red against the pre-phase-75 mirror on all three cases.
describe('wireRoute side-aware literals (CABLE-04, hand-written)', () => {
  interface SideAwareCase {
    name: string;
    from: WireDock;
    to: WireDock;
    cells: [number, number][];
  }
  const cases = JSON.parse(
    readFileSync(fixtureUrl('wire_side_aware.expected.json'), 'utf8'),
  ) as SideAwareCase[];

  it('the TS mirror reproduces every hand-written side-aware case', () => {
    expect(cases.length, 'CABLE-04 names exactly three hand-written cables').toBe(3);
    const mismatches: string[] = [];
    for (const c of cases) {
      const r = wireRoute(c.from, c.to);
      if (!r.ok) {
        mismatches.push(`${c.name}: the TS mirror refused it (${JSON.stringify(r.error)})`);
        continue;
      }
      const got = r.geometry.tiles.map((t) => [t.cell_x, t.cell_y]);
      if (JSON.stringify(got) !== JSON.stringify(c.cells)) {
        mismatches.push(`${c.name}: TS ${JSON.stringify(got)}, hand-written ${JSON.stringify(c.cells)}`);
      }
    }
    expect(mismatches.join('\n'), `${mismatches.length} of ${cases.length} cases diverged`).toBe('');
  });
});

// CHROME-19, D-09, the TypeScript half of `crates/fabrico-command/tests/wire_obstacles.rs`:
// the three measured reproductions (`92-MEASURE.md` section 4) through the preview copy of
// the obstacle stage. The literals are the Rust test's, which the exhaustive oracle
// `brute_force_route_avoiding` agrees with cell for cell; this asserts the mirror draws the
// same cables with the same candidate, and that the two-argument ladder is unchanged.
describe('wireRouteAvoiding around third machines (CHROME-19, D-09)', () => {
  const rect = (x: number, y: number, w: number, h: number): WireBody => ({
    min_x: x,
    min_y: y,
    max_x: x + w - 1,
    max_y: y + h - 1,
  });
  const repros: {
    name: string;
    from: WireDock;
    to: WireDock;
    machines: WireBody[];
    ladderInside: [number, number][];
    around: [number, number][];
  }[] = [
    {
      name: 'R1',
      from: { cell: [0, 0], side: 1, body: rect(0, 0, 1, 1) },
      to: { cell: [8, 0], side: 3, body: rect(8, -1, 3, 3) },
      machines: [rect(3, -1, 2, 2)],
      ladderInside: [
        [3, 0],
        [4, 0],
      ],
      around: [
        [0, 0], [1, 0], [2, 0], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [7, 0], [8, 0],
      ],
    },
    {
      name: 'R2',
      from: { cell: [0, 1], side: 1, body: rect(0, 1, 1, 1) },
      to: { cell: [6, 4], side: 3, body: rect(6, 4, 1, 1) },
      machines: [rect(4, 3, 2, 2)],
      ladderInside: [
        [5, 3],
        [5, 4],
      ],
      around: [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [6, 2], [6, 3], [6, 4]],
    },
    {
      name: 'R3',
      from: { cell: [10, 1], side: 3, body: rect(10, 0, 3, 3) },
      to: { cell: [0, 1], side: 1, body: rect(0, 1, 1, 1) },
      machines: [rect(5, 1, 1, 1), rect(3, 0, 1, 3)],
      ladderInside: [
        [5, 1],
        [3, 1],
      ],
      around: [
        [10, 1], [9, 1], [8, 1], [7, 1], [6, 1], [6, 0], [6, -1], [5, -1], [4, -1], [3, -1],
        [2, -1], [1, -1], [1, 0], [1, 1], [0, 1],
      ],
    },
  ];
  const inside = (c: [number, number], ms: WireBody[]): boolean =>
    ms.some((m) => c[0] >= m.min_x && c[0] <= m.max_x && c[1] >= m.min_y && c[1] <= m.max_y);

  it('draws each reproduction around its third machine, as the Rust stage does', () => {
    for (const r of repros) {
      const board = [r.to.body, ...r.machines, r.from.body];
      const got = wireRouteAvoidingTraced(r.from, r.to, board);
      expect(got.ok, `${r.name}: the mirror refused a routable pair`).toBe(true);
      if (!got.ok) continue;
      const cells = got.geometry.tiles.map((t): [number, number] => [t.cell_x, t.cell_y]);
      expect(cells.filter((c) => inside(c, r.machines)), `${r.name}: entered a third machine`).toEqual([]);
      expect(got.cand, `${r.name}: candidate`).toBe(CAND_AROUND_MACHINES);
      expect(cells, `${r.name}: tiles`).toEqual(r.around);
    }
  });

  it('leaves the two-argument ladder crossing at the measured cells', () => {
    for (const r of repros) {
      const got = wireRoute(r.from, r.to);
      expect(got.ok).toBe(true);
      if (!got.ok) continue;
      const cells = got.geometry.tiles.map((t): [number, number] => [t.cell_x, t.cell_y]);
      expect(cells.filter((c) => inside(c, r.machines)), `${r.name}: ladder crossing`).toEqual(r.ladderInside);
      // No machines, or only the two endpoint machines, is today's path and candidate.
      expect(wireRouteAvoidingTraced(r.from, r.to, []), `${r.name}: empty list`).toEqual(wireRouteTraced(r.from, r.to));
      expect(
        wireRouteAvoidingTraced(r.from, r.to, [r.from.body, r.to.body]),
        `${r.name}: endpoint machines only`,
      ).toEqual(wireRouteTraced(r.from, r.to));
    }
  });
});

// CHROME-19, D-09: the SECOND parity corpus, cables with machines in the way. Written by the
// Rust freezer `freeze_wire_obstacle_corpus` (`crates/fabrico-command/tests/wire_obstacle_corpus.rs`),
// whose gates hold every around-machines row to the exhaustive oracle; this holds the preview
// copy of the stage to the same rows, tile for tile and candidate for candidate, with the
// machine list as written (endpoints included, out of order on purpose), reversed and
// rotated.
describe('wireRouteAvoiding cross-language obstacle corpus (CHROME-19, D-09)', () => {
  interface ObstacleRow {
    docks: CorpusRow['docks'];
    machines: [number, number, number, number][];
    cand: number;
    tiles: [number, number, number, number, number][];
  }
  const rows = JSON.parse(
    readFileSync(fixtureUrl('wire_obstacle_corpus.expected.json'), 'utf8'),
  ) as ObstacleRow[];
  const bodies = (row: ObstacleRow): WireBody[] =>
    row.machines.map(([a, b, c, d]) => ({ min_x: a, min_y: b, max_x: c, max_y: d }));
  const encode = (r: ReturnType<typeof wireRouteAvoidingTraced>): number[][] | null =>
    r.ok
      ? r.geometry.tiles.map((t) =>
          'Straight' in t.kind
            ? [t.cell_x, t.cell_y, 0, t.kind.Straight.axis, -1]
            : [t.cell_x, t.cell_y, 1, t.kind.Corner.from, t.kind.Corner.to],
        )
      : null;

  it('reads the frozen sweep and its extra rows: 2869 rows, 1338 drawn around a machine, 2 crowded', () => {
    // 5 shape pairs x 4 x 4 sides x 5 offsets x 8 machine sets, less the 340 skipped sets, then
    // the nine extra rows of review fix pass 1 (four grid edges, the crowded column and two
    // crowded fields, a forged body off its dock, a dock neighbour inside a machine).
    expect(rows.length).toBe(5 * 4 * 4 * 5 * 8 - 340 + 9);
    expect(rows.filter((r) => r.cand === CAND_AROUND_MACHINES).length).toBe(1338);
    expect(rows.filter((r) => r.cand === CAND_AROUND_CROWDED).length).toBe(2);
  });

  it('the TS stage is tile and candidate equal to the Rust stage on every row, in any machine order', () => {
    const mismatches: string[] = [];
    for (const row of rows) {
      const [from, to] = docksOf({ docks: row.docks, cand: row.cand, tiles: row.tiles });
      const machines = bodies(row);
      const orders: [string, WireBody[]][] = [
        ['as written', machines],
        ['reversed', [...machines].reverse()],
        ['rotated', [...machines.slice(1), machines[0]]],
      ];
      for (const [name, list] of orders) {
        const r = wireRouteAvoidingTraced(from, to, list);
        const cand = r.ok ? r.cand : CAND_NONE;
        if (cand !== row.cand || JSON.stringify(encode(r)) !== JSON.stringify(row.tiles)) {
          mismatches.push(
            `${name}: docks ${JSON.stringify(row.docks)} machines ${JSON.stringify(row.machines)}\n` +
              `  rust cand=${row.cand} ${JSON.stringify(row.tiles)}\n  ts   cand=${cand} ${JSON.stringify(encode(r))}`,
          );
        }
      }
    }
    expect(mismatches.slice(0, 3).join('\n'), `${mismatches.length} row orders diverged`).toBe('');
  });
});

// The node lookup is TOTAL (todo `2026-10-06-wireroute-ts-nodeof-not-total.md`): a cell off
// the line set is no node, never another node's index, and a search handed such an end finds
// no path rather than walking from the wrong place, and never throws (a throw in a Pixi
// ticker listener kills the renderer, threat T-92-07).
describe('the search node lookup is total (T-92-07)', () => {
  const xs = [0, 1, 2];
  const ys = [0, 1, 2];

  it('answers -1 for a cell off either axis of the line set', () => {
    expect(nodeIndexOf(xs, ys, [1, 1])).toBe(4);
    expect(nodeIndexOf(xs, ys, [5, 1]), 'x off the lines').toBe(-1);
    expect(nodeIndexOf(xs, ys, [1, 5]), 'y off the lines').toBe(-1);
    expect(nodeIndexOf(xs, ys, [5, 5]), 'both off the lines').toBe(-1);
  });

  it('finds no path, and does not throw, from or to an end off the line set', () => {
    const finish = { cell: [2, 2] as [number, number], dir: [1, 0] as [number, number], missed: false };
    const offStart = { cell: [5, 1] as [number, number], dir: [1, 0] as [number, number], missed: false };
    const onStart = { cell: [0, 1] as [number, number], dir: [1, 0] as [number, number], missed: false };
    // Precondition: from a start on the lines the same search does find a path.
    expect(searchOnLines([], xs, ys, [onStart], [finish])).not.toBeNull();
    expect(() => searchOnLines([], xs, ys, [offStart], [finish])).not.toThrow();
    expect(searchOnLines([], xs, ys, [offStart], [finish]), 'start off the lines').toBeNull();
    expect(searchOnLines([], xs, ys, [onStart], [{ ...finish, cell: [2, 9] }]), 'finish off the lines').toBeNull();
  });
});
