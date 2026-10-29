import { afterEach, describe, expect, it } from 'vitest';
import type { BeltDockView, BeltView, TileView } from '../protocol/decode.ts';
import {
  clearPendingSeams,
  endPendingSeams,
  pendingSeamTiles,
  pendingSeamsRecord,
  pendingSeamsRecords,
  recordPendingSeams,
  resumePendingSeams,
  setPendingSeamsPlayState,
  type PendingSeamRecord,
} from './pendingSeams.ts';

// pendingSeams.ts (plan 74.1-20, review WR-05): the seam kinds a just-drawn belt is
// DRAWN with between the release and the echo of its follow-up Docks.
//
// Every case states its NON-VACUITY beside its claim: a "no answer" case first shows
// the same record answering for the matching belt, so a registry that never answers
// cannot pass the negative half.
//
// Wire numbering: Dir N=0 E=1 S=2 W=3, Axis X=0 Y=1.

const STRAIGHT_Y = { Straight: { axis: 1 } };
const CORNER_E_N = { Corner: { from: 1, to: 0 } };
const CORNER_E_S = { Corner: { from: 1, to: 2 } };
const CORNER_S_E = { Corner: { from: 2, to: 1 } };

const t = (cx: number, cy: number, kind: TileView['kind']): TileView => ({
  cell_x: cx,
  cell_y: cy,
  kind,
});

/** The S1 belt as route() types it: (8,6) then north, every tile Straight{Y}. */
const S1_STORED = [t(8, 6, STRAIGHT_Y), t(8, 5, STRAIGHT_Y), t(8, 4, STRAIGHT_Y)];
/** The S1 prediction: tiles[0] fed east by the pressed belt Head, leaving north. */
const S1_PREDICTED = [t(8, 6, CORNER_E_N), t(8, 5, STRAIGHT_Y), t(8, 4, STRAIGHT_Y)];
const S1_CELLS: Array<[number, number]> = [
  [8, 6],
  [8, 5],
  [8, 4],
];

const belt = (id: number, tiles: TileView[], docks: BeltDockView[] = []): BeltView =>
  ({
    id,
    latency: 4 * tiles.length,
    fill: 0,
    items: [],
    tiles,
    docks,
    ticks_per_slot: 1,
  }) as BeltView;

const s1Record = (over: Partial<PendingSeamRecord> = {}): PendingSeamRecord => ({
  cells: S1_CELLS,
  tiles: S1_PREDICTED,
  expect: { Tail: true, Head: false },
  tick: 100,
  ttlTicks: 120,
  ...over,
});

const kindsOf = (tiles: TileView[] | null): unknown[] | null =>
  tiles === null ? null : tiles.map((x) => x.kind);

afterEach(() => {
  clearPendingSeams();
  setPendingSeamsPlayState(null);
});

describe('pendingSeams: the predicted seam kinds of a just-drawn belt (74.1-20, WR-05)', () => {
  it('answers the predicted end kind for a belt with EXACTLY the recorded cells and no dock yet', () => {
    recordPendingSeams(s1Record());
    const answer = pendingSeamTiles(belt(9, S1_STORED), 101);
    expect(kindsOf(answer), 'tiles[0] is the corner, the rest are the belt\'s own').toEqual([
      CORNER_E_N,
      STRAIGHT_Y,
      STRAIGHT_Y,
    ]);
    // The cells are the belt's, never re-typed.
    expect(answer?.map((x) => [x.cell_x, x.cell_y])).toEqual(S1_CELLS);
  });

  it('never mutates the belt it answers for (the decoded scene is not altered)', () => {
    recordPendingSeams(s1Record());
    const b = belt(9, S1_STORED.map((x) => ({ ...x })));
    const before = JSON.stringify(b);
    expect(pendingSeamTiles(b, 101), 'NON-VACUITY: it answered').not.toBeNull();
    expect(JSON.stringify(b), 'the belt is byte-identical after the read').toBe(before);
  });

  it('answers nothing for a belt whose cells differ in one cell, or in length', () => {
    recordPendingSeams(s1Record());
    expect(pendingSeamTiles(belt(9, S1_STORED), 101), 'NON-VACUITY').not.toBeNull();
    const moved = [t(8, 6, STRAIGHT_Y), t(8, 5, STRAIGHT_Y), t(9, 5, STRAIGHT_Y)];
    expect(pendingSeamTiles(belt(10, moved), 101)).toBeNull();
    expect(pendingSeamTiles(belt(11, S1_STORED.slice(0, 2)), 101)).toBeNull();
    // A non-matching belt does not consume the record.
    expect(pendingSeamsRecord(), 'the record survives a read of another belt').not.toBeNull();
  });

  it('stops answering, and clears, once the expected end carries its dock (the dock echo)', () => {
    recordPendingSeams(s1Record());
    expect(pendingSeamTiles(belt(9, S1_STORED), 101), 'NON-VACUITY').not.toBeNull();
    // The Dock echo: the packet now carries the Tail dock and its own derived corner.
    const docked = belt(9, S1_PREDICTED, [{ end: 'Tail', node: 7, port: 1 }]);
    expect(pendingSeamTiles(docked, 103)).toBeNull();
    expect(pendingSeamsRecord(), 'resolved records clear').toBeNull();
  });

  it('a dock on the OTHER end does not resolve the expected one', () => {
    recordPendingSeams(s1Record());
    const headOnly = belt(9, S1_STORED, [{ end: 'Head', node: 7, port: 0 }]);
    expect(kindsOf(pendingSeamTiles(headOnly, 101))?.[0]).toEqual(CORNER_E_N);
  });

  it('with both ends expected, a landed end reads the packet and the pending end the prediction', () => {
    // A two-ended prediction: Tail corner E->S, Head corner S->E (made-up kinds; the
    // registry composes per end and never derives).
    const stored = [t(3, 5, STRAIGHT_Y), t(3, 6, STRAIGHT_Y), t(3, 7, STRAIGHT_Y)];
    const predicted = [t(3, 5, CORNER_E_S), t(3, 6, STRAIGHT_Y), t(3, 7, CORNER_S_E)];
    recordPendingSeams({
      cells: [
        [3, 5],
        [3, 6],
        [3, 7],
      ],
      tiles: predicted,
      expect: { Tail: true, Head: true },
      tick: 0,
      ttlTicks: 120,
    });
    expect(kindsOf(pendingSeamTiles(belt(4, stored), 1))).toEqual([CORNER_E_S, STRAIGHT_Y, CORNER_S_E]);
    // The Head dock lands first, with the packet's own Head kind (here: still Straight,
    // a host that disagreed with the prediction): the packet wins at the landed end.
    const headLanded = belt(4, stored, [{ end: 'Head', node: 2, port: 0 }]);
    expect(kindsOf(pendingSeamTiles(headLanded, 2))).toEqual([CORNER_E_S, STRAIGHT_Y, STRAIGHT_Y]);
    // Both land: resolved.
    const both = belt(4, stored, [
      { end: 'Head', node: 2, port: 0 },
      { end: 'Tail', node: 1, port: 0 },
    ]);
    expect(pendingSeamTiles(both, 3)).toBeNull();
    expect(pendingSeamsRecord()).toBeNull();
  });

  it('answers through the TTL tick inclusive, and expires (and clears) one tick past it', () => {
    recordPendingSeams(s1Record({ tick: 100, ttlTicks: 120 }));
    expect(kindsOf(pendingSeamTiles(belt(9, S1_STORED), 220))?.[0], 'tick 220 = 100 + 120').toEqual(
      CORNER_E_N,
    );
    expect(pendingSeamTiles(belt(9, S1_STORED), 221), 'a refused Dock: the stored Straight shows').toBeNull();
    expect(pendingSeamsRecord(), 'expired records clear').toBeNull();
  });

  // ONE RECORD PER BELT (plan 74.1-30, PAUSE-SECOND-DRAW). Until then a new record
  // superseded the old one, so a second belt drawn while paused drew the first belt's seam
  // straight on Play. Each record now stands on its own cells.
  const OTHER_CELLS: Array<[number, number]> = [
    [1, 1],
    [1, 2],
  ];
  const OTHER_STORED = [t(1, 1, STRAIGHT_Y), t(1, 2, STRAIGHT_Y)];
  const otherRecord = (over: Partial<PendingSeamRecord> = {}): PendingSeamRecord => ({
    cells: OTHER_CELLS,
    tiles: [t(1, 1, CORNER_E_S), t(1, 2, STRAIGHT_Y)],
    expect: { Tail: true, Head: false },
    tick: 100,
    ttlTicks: 120,
    ...over,
  });

  it('holds one record PER BELT: a record on other cells leaves the first answering', () => {
    recordPendingSeams(s1Record());
    recordPendingSeams(otherRecord());
    expect(pendingSeamsRecords(), 'two records').toHaveLength(2);
    expect(kindsOf(pendingSeamTiles(belt(9, S1_STORED), 101))?.[0], 'the first still answers').toEqual(CORNER_E_N);
    expect(kindsOf(pendingSeamTiles(belt(5, OTHER_STORED), 101))?.[0], 'the second answers too').toEqual(CORNER_E_S);
  });

  it('a record with EXACTLY the same cells replaces that record, and only that one', () => {
    recordPendingSeams(s1Record());
    recordPendingSeams(otherRecord());
    recordPendingSeams(s1Record({ tiles: S1_STORED, tick: 150 }));
    expect(pendingSeamsRecords(), 'still two records').toHaveLength(2);
    expect(kindsOf(pendingSeamTiles(belt(9, S1_STORED), 151))?.[0], 'the S1 cells now answer the new tiles').toEqual(
      STRAIGHT_Y,
    );
    expect(kindsOf(pendingSeamTiles(belt(5, OTHER_STORED), 151))?.[0], 'the other is untouched').toEqual(CORNER_E_S);
    // A same-cell record that expects no dock drops that record and stores nothing.
    recordPendingSeams(s1Record({ expect: { Tail: false, Head: false } }));
    expect(pendingSeamsRecords().map((r) => r.cells)).toEqual([OTHER_CELLS]);
  });

  it('each record clears on its OWN dock echo; the other keeps answering', () => {
    recordPendingSeams(s1Record());
    recordPendingSeams(otherRecord());
    const docked = belt(9, S1_PREDICTED, [{ end: 'Tail', node: 7, port: 1 }]);
    expect(pendingSeamTiles(docked, 103), 'S1 resolved').toBeNull();
    expect(pendingSeamsRecords().map((r) => r.cells), 'only the S1 record is gone').toEqual([OTHER_CELLS]);
    expect(kindsOf(pendingSeamTiles(belt(5, OTHER_STORED), 103))?.[0]).toEqual(CORNER_E_S);
  });

  it('each record expires on its OWN TTL; a later one keeps answering', () => {
    recordPendingSeams(s1Record({ tick: 100, ttlTicks: 120 }));
    recordPendingSeams(otherRecord({ tick: 200, ttlTicks: 120 }));
    expect(pendingSeamTiles(belt(9, S1_STORED), 221), 'S1 is one tick past its TTL').toBeNull();
    expect(pendingSeamsRecords().map((r) => r.cells), 'only the expired record is gone').toEqual([OTHER_CELLS]);
    expect(kindsOf(pendingSeamTiles(belt(5, OTHER_STORED), 221))?.[0], 'tick 221 is inside 200 + 120').toEqual(
      CORNER_E_S,
    );
  });

  it('clearPendingSeams (teardown) drops EVERY record', () => {
    recordPendingSeams(s1Record());
    recordPendingSeams(otherRecord());
    expect(pendingSeamTiles(belt(9, S1_STORED), 101), 'NON-VACUITY').not.toBeNull();
    clearPendingSeams();
    expect(pendingSeamTiles(belt(9, S1_STORED), 101)).toBeNull();
    expect(pendingSeamTiles(belt(5, OTHER_STORED), 101)).toBeNull();
    expect(pendingSeamsRecord()).toBeNull();
    expect(pendingSeamsRecords()).toEqual([]);
  });

  it('a record that expects no dock is never stored', () => {
    recordPendingSeams(s1Record({ expect: { Tail: false, Head: false } }));
    expect(pendingSeamsRecord()).toBeNull();
    expect(pendingSeamTiles(belt(9, S1_STORED), 101)).toBeNull();
  });

  // PAUSE-AWARE (plan 88-06, BELT-05, D-07). A paused board still drains ticks with input
  // held, for up to 512, so a record must not count them: until plan 88-06 a draw released
  // early in a long drain lost its predicted corner while still paused.
  it('a_seam_record_does_not_expire_while_paused', () => {
    recordPendingSeams(s1Record({ tick: 100, ttlTicks: 120 }));
    expect(
      kindsOf(pendingSeamTiles(belt(9, S1_STORED), 1000, false))?.[0],
      'read far past its TTL while paused: still the prediction',
    ).toEqual(CORNER_E_N);
    expect(pendingSeamsRecord(), 'and the record is kept').not.toBeNull();
    // The registered play state is what a read with no third argument consults (the belts layer).
    setPendingSeamsPlayState(() => false);
    expect(kindsOf(pendingSeamTiles(belt(9, S1_STORED), 1000))?.[0], 'paused by the registered read').toEqual(
      CORNER_E_N,
    );
    // Resume at 1000: the count restarts there and runs on playing ticks.
    resumePendingSeams(1000);
    setPendingSeamsPlayState(() => true);
    expect(kindsOf(pendingSeamTiles(belt(9, S1_STORED), 1120))?.[0], '120 playing ticks after Resume').toEqual(
      CORNER_E_N,
    );
    expect(pendingSeamTiles(belt(9, S1_STORED), 1121), 'one playing tick past: the stored Straight').toBeNull();
    expect(pendingSeamsRecord(), 'expired records clear').toBeNull();
  });

  it('endPendingSeams ends only the records its owner recorded (a refused DrawBelt or Dock, D-06)', () => {
    recordPendingSeams(s1Record({ owner: 7 }));
    recordPendingSeams(otherRecord({ owner: 8 }));
    expect(pendingSeamsRecords(), 'NON-VACUITY: two records').toHaveLength(2);
    endPendingSeams(9);
    expect(pendingSeamsRecords(), 'an owner with no record ends nothing').toHaveLength(2);
    endPendingSeams(7);
    expect(pendingSeamsRecords().map((r) => r.cells), 'only owner 7').toEqual([OTHER_CELLS]);
    expect(pendingSeamTiles(belt(9, S1_STORED), 101), 'its belt draws the packet').toBeNull();
    expect(kindsOf(pendingSeamTiles(belt(5, OTHER_STORED), 101))?.[0], 'the other still answers').toEqual(CORNER_E_S);
  });

  it('a single-tile belt takes the predicted kind on its one tile while either expected end is pending', () => {
    recordPendingSeams({
      cells: [[3, 5]],
      tiles: [t(3, 5, CORNER_E_S)],
      expect: { Tail: true, Head: true },
      tick: 0,
      ttlTicks: 120,
    });
    const lone = [t(3, 5, STRAIGHT_Y)];
    expect(kindsOf(pendingSeamTiles(belt(4, lone), 1))).toEqual([CORNER_E_S]);
    const tailLanded = belt(4, lone, [{ end: 'Tail', node: 1, port: 0 }]);
    expect(kindsOf(pendingSeamTiles(tailLanded, 1)), 'the Head is still pending').toEqual([CORNER_E_S]);
  });
});
