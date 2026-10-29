// THE RELEASE GRADER ON SYNTHETIC TRACES (plan 77-03, phase 77 D-15).
//
// `e2e-live/support/jamGrading.ts` grades leg 3 of the composed walk off the in-page tick
// recorder: the jam's fractions, the pack order, the release order and its pseudo-R form, the
// thinning, the sustained window and the outlet at steady state. It is pure (plain data in,
// plain data out), so every rule it applies is pinned here on traces written by hand, each one
// small enough to grade in your head. The counter-traces are the defects the grader exists to
// refuse; each must yield the violation it names, so a grader weakened to accept it reddens here
// (77-MUTATION-PROOF.md, B12-weak and B12-close-unit).
//
// THE RECORDED TRACES (plan 77-09). The release and steady-jam traces plan 77-03's D-15
// measurement kept are committed under `fixtures/`, trimmed to the fields the grader reads (the
// Tee's state, the three belts' paces and occupancy), each with the line its run logged as its
// `expected` field. The grader must reproduce every logged line from them, so the measurement in
// 77-MUTATION-PROOF.md ("Plan 77-03 D-15 measurement") can be re-derived from the repository, and
// the counter-traces are rebuilt from real release trace 1 beside the synthetic ones.
//
// THE DRIP IN FLIGHT AT R (the 77-03 refuter round, refuter 4). Plan 77-03 graded two correct
// releases wrong-way and cut the clause on them. Both landed while a drip was part-way through, so
// the upstream's next delivery was the drip's refill, scheduled before R, and the grader called it
// the release. The `DRIP IN FLIGHT` cases pin the rule that skips that refill, the two bounds that
// keep it sound when the recorder misses ticks, and a counter-trace it must still refuse. The two
// traces are kept with the lines their runs logged (`expected`), and graded again here.
//
// Lives under `src/` because `vitest.config.ts` includes `src/**/*.{test,spec}.{ts,tsx}` only.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  flowingBaseline,
  frontFirstViolations,
  gaugeFormsByDrawnTick,
  gaugeReleaseViolations,
  gradeReleaseOrder,
  mergedFraction,
  jamFractions,
  outletSteadyViolations,
  packsBackwards,
  pseudoRLine,
  mergedBarAgainstDrips,
  releaseOrderLine,
  releaseSustained,
  thinningTicks,
  type GaugeForm,
  type JamIds,
  type JamRecord,
} from '../../e2e-live/support/jamGrading';

const IDS: JamIds = { teeId: 7, inletId: 3, upstreamId: 2, outletId: 9 };
const WORKING = 1;
const BACKED_UP = 3;
const FAST = 2;
const SLOW = 20;

/** Slots `from..to` inclusive. */
function span(from: number, to: number): number[] {
  const out: number[] = [];
  for (let s = from; s <= to; s++) out.push(s);
  return out;
}
const FULL = span(0, 11);

interface Row {
  t: number;
  tee: number;
  inlet: number[];
  up: number[];
  outlet?: number[];
  outletPace?: number;
}

/** One record in the recorder's shape. */
function rec(r: Row): JamRecord {
  return {
    t: r.t,
    nodes: [
      [IDS.teeId, 3, r.tee],
      [11, 7, WORKING],
    ],
    belts: [
      [IDS.upstreamId, FAST, [...r.up], []],
      [IDS.inletId, FAST, [...r.inlet], []],
      [IDS.outletId, r.outletPace ?? SLOW, [...(r.outlet ?? span(0, 11))], []],
    ],
  };
}

/** A copy of `trace` with the record at tick `t` rebuilt through `patch`. The ONE helper every
 *  counter-trace is built by, so each differs from its source in exactly what it names. */
function edit(trace: JamRecord[], t: number, patch: Partial<Row>): JamRecord[] {
  return trace.map((r) => {
    if (r.t !== t) return r;
    const tee = r.nodes.find((n) => n[0] === IDS.teeId)![2];
    const slots = (id: number) => r.belts.find((b) => b[0] === id)![2];
    const pace = r.belts.find((b) => b[0] === IDS.outletId)![1];
    return rec({
      t,
      tee,
      inlet: slots(IDS.inletId),
      up: slots(IDS.upstreamId),
      outlet: slots(IDS.outletId),
      outletPace: pace,
      ...patch,
    });
  });
}

/**
 * THE FORWARD TRACE, modelled on research run A (R 1648). Before R the line is jammed: the Tee
 * `BACKED_UP`, both run belts packed, the outlet slow. At R the outlet carries the fast pace and
 * the Tee is off `BACKED_UP`. At R+1 the inlet's slot 0 is empty (FRONT FREE). At R+2 the inlet
 * shifts (its count and highest slot do not rise). At R+3 its head goes to the Tee. At R+4 the
 * upstream delivers into the inlet's tail: the upstream's slot 0 empties (a), the inlet's count
 * rises (b) and its highest slot rises (c). Witness records: R+1, R+2, R+3.
 */
function forwardTrace(): JamRecord[] {
  const out: JamRecord[] = [];
  for (let t = 1640; t < 1648; t++) out.push(rec({ t, tee: BACKED_UP, inlet: FULL, up: FULL }));
  out.push(rec({ t: 1648, tee: WORKING, inlet: FULL, up: FULL, outletPace: FAST }));
  out.push(rec({ t: 1649, tee: WORKING, inlet: span(1, 11), up: FULL, outletPace: FAST }));
  out.push(rec({ t: 1650, tee: WORKING, inlet: span(0, 10), up: FULL, outletPace: FAST }));
  out.push(rec({ t: 1651, tee: WORKING, inlet: span(1, 10), up: FULL, outletPace: FAST }));
  out.push(rec({ t: 1652, tee: WORKING, inlet: span(1, 11), up: span(1, 11), outletPace: FAST }));
  for (let t = 1653; t < 1700; t++) {
    out.push(
      rec({
        t,
        tee: WORKING,
        inlet: t % 2 === 0 ? span(1, 11) : span(0, 10),
        up: t % 2 === 0 ? span(1, 11) : span(0, 10),
        outletPace: FAST,
      }),
    );
  }
  return out;
}

describe('gradeReleaseOrder, the release order on the sim clock', () => {
  it('grades the forward trace with no violation and three witness records', () => {
    const grade = gradeReleaseOrder(forwardTrace(), IDS, FAST);
    expect(grade).toMatchObject({
      R: 1648,
      teeOff: 1648,
      frontFree: 1649,
      junction: 1652,
      witness: 3,
      wrongway: 0,
      unobservable: null,
    });
    expect(grade.witness).toBeGreaterThanOrEqual(2);
    expect(frontFirstViolations(grade)).toEqual([]);
    expect(releaseOrderLine(grade)).toBe(
      'RELEASE_ORDER R=1648 teeOff=1648 frontFree=1649 junction=1652 missed=0 witness=3 wrongway=0',
    );
  });

  it('counts the ticks the recorder missed inside the graded span', () => {
    const missing = forwardTrace().filter((r) => r.t !== 1646 && r.t !== 1647 && r.t !== 1650);
    const grade = gradeReleaseOrder(missing, IDS, FAST);
    expect({ R: grade.R, missed: grade.missed, witness: grade.witness }).toEqual({
      R: 1648,
      missed: 3,
      witness: 2,
    });
  });

  it('REFUSES upstream shifted at R with its tail refilled', () => {
    // The upstream's occupancy reads the same before and after a junction delivery, because it
    // shifted and the Source refilled its tail in the same tick: occupancy-set equality cannot
    // see that move. Here the junction delivers at R+1, BEFORE FRONT FREE, and only the inlet's
    // count says so. A grader that trusted the upstream's occupancy alone would find a witness
    // here and pass it. The record before R is the packed jam (no drip in flight), so the
    // drip-in-flight rule does not apply.
    // Edits to the forward trace: at R the Tee still reads BACKED_UP and has taken the inlet's
    // head (1..11); at R+1 the inlet reads 0..11 again (its count rose: the junction) with the
    // upstream still 0..11; at R+2 the Tee is off with the head empty (FRONT FREE); the record at
    // R+4 keeps the upstream at 0..11, so its occupancy first differs at R+5.
    let trace = edit(forwardTrace(), 1648, { tee: BACKED_UP, inlet: span(1, 11) });
    trace = edit(trace, 1649, { tee: BACKED_UP, inlet: FULL, up: FULL });
    trace = edit(trace, 1650, { inlet: span(1, 11) });
    trace = edit(trace, 1652, { inlet: span(1, 10), up: FULL });
    const grade = gradeReleaseOrder(trace, IDS, FAST);
    expect(grade.dripRefill, 'no drip was in flight before R').toBeNull();
    expect(grade.frontFree).toBe(1650);
    expect(grade.junction, 'the inlet refill at R+1 is the junction').toBe(1649);
    expect(frontFirstViolations(grade)).toContainEqual(
      expect.stringMatching(/at or before FRONT FREE/),
    );
    expect(grade.wrongway).toBe(1);
  });

  it('REFUSES junction delivery in the front-free record', () => {
    const trace = edit(forwardTrace(), 1649, { up: span(1, 11) });
    const grade = gradeReleaseOrder(trace, IDS, FAST);
    expect({ frontFree: grade.frontFree, junction: grade.junction, witness: grade.witness }).toEqual({
      frontFree: 1649,
      junction: 1649,
      witness: 0,
    });
    expect(frontFirstViolations(grade)).toContainEqual(
      expect.stringMatching(/at or before FRONT FREE/),
    );
  });

  it('REFUSES front never frees', () => {
    const trace = forwardTrace().map((r) =>
      r.t >= 1648 ? edit([r], r.t, { tee: BACKED_UP })[0] : r,
    );
    const grade = gradeReleaseOrder(trace, IDS, FAST);
    expect(grade.frontFree).toBeNull();
    expect(grade.wrongway).toBe(1);
    expect(frontFirstViolations(grade)).toContainEqual(expect.stringMatching(/^no FRONT FREE/));
  });

  it('REFUSES a recording that never carries the fast outlet pace', () => {
    const trace = forwardTrace().map((r) => edit([r], r.t, { outletPace: SLOW })[0]);
    const grade = gradeReleaseOrder(trace, IDS, FAST);
    expect(grade.R).toBeNull();
    expect(frontFirstViolations(grade)).toContainEqual(expect.stringMatching(/^no R/));
  });

  it('reads an R whose upstream head was already empty in the record before it (the refill landed there)', () => {
    // Plan 77-03 called this unobservable: the upstream's next change is its own refill, not the
    // release arriving. The drip rule (the 77-03 refuter round) reads it: no refill is pending (the
    // inlet is full there), so the junction is the first possible delivery after it, 1652.
    const trace = edit(forwardTrace(), 1647, { up: span(1, 11) });
    const grade = gradeReleaseOrder(trace, IDS, FAST);
    expect(grade).toMatchObject({ unobservable: null, frontFree: 1649, junction: 1652, wrongway: 0, dripRefill: { refill: 1647, hidden: 0 } });
    expect(frontFirstViolations(grade)).toEqual([]);
  });

  it('REFUSES an R whose upstream head was empty before it when the release reaches the upstream first', () => {
    let trace = edit(forwardTrace(), 1647, { up: span(1, 11) });
    trace = edit(trace, 1649, { tee: BACKED_UP, up: span(1, 11) });
    const grade = gradeReleaseOrder(trace, IDS, FAST);
    // The Tee stays BACKED_UP at 1649, the inlet's head refills at 1650, so FRONT FREE is 1651.
    expect({ junction: grade.junction, frontFree: grade.frontFree, wrongway: grade.wrongway }).toEqual({
      junction: 1649,
      frontFree: 1651,
      wrongway: 1,
    });
    expect(frontFirstViolations(grade)).toContainEqual(expect.stringMatching(/at or before FRONT FREE/));
  });

  it('takes R from rTick when it is given (the pseudo-R form)', () => {
    const grade = gradeReleaseOrder(forwardTrace(), IDS, FAST, 1644);
    expect({ R: grade.R, frontFree: grade.frontFree }).toEqual({ R: 1644, frontFree: 1649 });
  });
});

/**
 * THE SYNTHETIC DRIP. 120 records of a steady jam (t 0..119): the Tee `BACKED_UP`, both run belts
 * packed. Every 20 records, at d = 10, 30, 50, 70, 90, 110: at d the Tee reads `WORKING` with the
 * inlet's slot 0 empty; at d+1 the Tee is back on `BACKED_UP` and the inlet has shifted; at d+2
 * the upstream delivers into the inlet's tail (the junction refills two records later); at d+3
 * the upstream shifts; at d+4 the Source refills its tail.
 */
function dripTrace(): JamRecord[] {
  const out: JamRecord[] = [];
  for (let t = 0; t < 120; t++) {
    const d = t % 20;
    let row: Row = { t, tee: BACKED_UP, inlet: FULL, up: FULL };
    if (d === 10) row = { t, tee: WORKING, inlet: span(1, 11), up: FULL };
    if (d === 11) row = { t, tee: BACKED_UP, inlet: span(0, 10), up: FULL };
    if (d === 12) row = { t, tee: BACKED_UP, inlet: FULL, up: span(1, 11) };
    if (d === 13) row = { t, tee: BACKED_UP, inlet: FULL, up: span(0, 10) };
    out.push(rec(row));
  }
  return out;
}

describe('pseudoRLine, the grader asked about drips with no release in them', () => {
  it('PSEUDO-R in a synthetic drip', () => {
    // Graded: every record with a record before it and at least 40 after it, indices 1..79, so
    // 79 gradings. This synthetic drip shows FRONT FREE inside every drip (at d the Tee reads
    // WORKING with the inlet's head empty), which the measured drip never does (the next case):
    // it is the drip a grader would be fooled by, and why PSEUDO-R is read on the measured one.
    // Per drip at d: an R at d+1 or d+2 has the inlet short of full in the record before it, so
    // the drip rule (the 77-03 refuter round) skips this drip's refill at d+2 and its junction is
    // the next drip's at d+22, after that drip's FRONT FREE at d+20: front-first. An R at d+3 has
    // the refill landed on the record before it (the upstream's slot 0 empty, the inlet full), so
    // its junction is again the next drip's: front-first (plan 77-03 called it unobservable). An R
    // at d+4 sees the Source refill as the upstream moving (a violation). Every other R sees the
    // next drip's FRONT FREE two records before its junction refill: front-first.
    //   i = 1..13            : 13 front-first (the first drip at 10; i = 11 to 13 by the drip rule)
    //   i = 14               :  1 violation (drip 10)
    //   i = 15..33           : 19 front-first
    //   i = 34               :  1 violation (drip 30)
    //   i = 35..53           : 19 front-first
    //   i = 54               :  1 violation (drip 50)
    //   i = 55..73           : 19 front-first
    //   i = 74               :  1 violation (drip 70)
    //   i = 75..79           :  5 front-first
    // front-first = 13 + 19 + 19 + 19 + 5 = 75 of 79 (63 before the drip rule).
    expect(pseudoRLine(dripTrace(), IDS)).toBe('PSEUDO_R graded=79 frontFirst=75');
  });

  it('PSEUDO-R in the measured drip', () => {
    // The drip as the live host records it (plan 77-03 Task 1, `t1-jam.json` ticks 2062-2066):
    // the Tee reads WORKING on the tick it emits, while the inlet's head is STILL occupied; on
    // the next tick the inlet delivers its head, the Tee is back on BACKED_UP, and the head reads
    // empty for three records; then the junction refills. FRONT FREE (the Tee off BACKED_UP AND
    // the head empty in one record) never happens, so no pseudo-R grades without a violation.
    const out: JamRecord[] = [];
    for (let t = 0; t < 120; t++) {
      const d = t % 20;
      let row: Row = { t, tee: BACKED_UP, inlet: FULL, up: FULL };
      if (d === 5) row = { t, tee: WORKING, inlet: FULL, up: FULL };
      if (d === 6 || d === 7) row = { t, tee: BACKED_UP, inlet: span(1, 11), up: FULL };
      if (d === 8) row = { t, tee: BACKED_UP, inlet: span(1, 10), up: FULL };
      if (d === 9) row = { t, tee: BACKED_UP, inlet: FULL, up: span(1, 11) };
      out.push(rec(row));
    }
    expect(pseudoRLine(out, IDS)).toBe('PSEUDO_R graded=79 frontFirst=0');
  });
});

describe('packsBackwards, the pack order from the slow-pace record (the tie rule)', () => {
  /** P = prefix(inlet) + (prefix(inlet) is 12 ? prefix(upstream) : 0). */
  function packTrace(ps: number[]): JamRecord[] {
    return ps.map((p, i) => {
      const inlet = span(0, Math.min(p, 12) - 1);
      const up = p > 12 ? span(0, p - 13) : [];
      return rec({ t: 500 + i * 3, tee: BACKED_UP, inlet, up });
    });
  }

  it('grades a pack growing from empty with no violation', () => {
    const grade = packsBackwards(packTrace([0, 1, 2, 3, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]), IDS);
    expect(grade.firsts).toEqual([512, 518, 524, 530, 536, 542]);
    expect(grade.violations).toEqual([]);
  });

  it('REFUSES thresholds already met at the first graded record', () => {
    // The packed run leg 2 left, inherited: every boundary is met on the first record, so all of
    // them share one tick. That is a tie, never "strictly increasing from nothing".
    const grade = packsBackwards(packTrace([24, 24, 24]), IDS);
    expect(grade.violations).toContainEqual(expect.stringMatching(/already met at the first graded record/));
  });

  it('REFUSES two boundaries first reached on one record', () => {
    const grade = packsBackwards(packTrace([0, 3, 9, 12, 16, 20, 24]), IDS);
    expect(grade.violations).toContainEqual(expect.stringMatching(/boundary 8 .* same tick/));
  });

  it('REFUSES a pack that never reaches the whole run', () => {
    const grade = packsBackwards(packTrace([0, 4, 8, 12, 16]), IDS);
    expect(grade.violations).toContainEqual(expect.stringMatching(/never reached 20/));
  });
});

describe('the fractions', () => {
  it('jamFractions reads the BACKED_UP and head-held fractions', () => {
    expect(jamFractions(dripTrace(), IDS)).toEqual({ records: 120, backedUp: 114 / 120, headHeld: 114 / 120 });
  });

  it('flowingBaseline reads the head and the item counts', () => {
    const trace = [0, 1, 2, 3].map((i) =>
      rec({ t: i, tee: WORKING, inlet: i === 0 ? [0, 4, 8] : [2, 6, 10], up: [1, 5, 9, 11] }),
    );
    expect(flowingBaseline(trace, IDS)).toEqual({
      records: 4,
      headOccupied: 0.25,
      inletMean: 3,
      inletMax: 3,
      upstreamMean: 4,
      upstreamMax: 4,
    });
  });
});

describe('thinningTicks and releaseSustained, the window placed after the measured thinning', () => {
  /** Tile k (0 = the upstream's tail tile .. 5 = the inlet's head tile) thins for good at
   *  THIN[k]. Tile 5 dips to 2 at t 105..107 and refills, so "stays at or below 2 to the end"
   *  must not take the dip. Counts sit in each tile's TAIL-most slots, so a thinned inlet head
   *  tile leaves slot 0 empty. */
  const THIN = [110, 115, 120, 125, 130, 140];
  function thinTrace(): JamRecord[] {
    const out: JamRecord[] = [];
    for (let t = 100; t < 300; t++) {
      const counts = THIN.map((T, k) => (t >= T ? 1 : k === 5 && t >= 105 && t <= 107 ? 2 : 4));
      const tileSlots = (k: number): number[] => {
        const hi = 11 - 4 * (k % 3);
        return span(hi - counts[k] + 1, hi);
      };
      const up = [0, 1, 2].flatMap(tileSlots).sort((a, b) => a - b);
      const inlet = [3, 4, 5].flatMap(tileSlots).sort((a, b) => a - b);
      out.push(rec({ t, tee: t >= 100 ? WORKING : BACKED_UP, inlet, up, outletPace: FAST }));
    }
    return out;
  }

  it('gives every tile its thinning tick, the dip not counted', () => {
    expect(thinningTicks(thinTrace(), IDS)).toEqual(THIN);
  });

  it('gives no tick to a tile that is still above 2 at the end of the recording', () => {
    const cut = thinTrace().filter((r) => r.t < 135);
    expect(thinningTicks(cut, IDS)).toEqual([110, 115, 120, 125, 130, null]);
  });

  it('places the sustained window after the latest tile thinned', () => {
    const trace = thinTrace();
    const latest = Math.max(...(thinningTicks(trace, IDS) as number[]));
    const win = releaseSustained(trace, IDS, latest + 20, 60);
    expect(win).toEqual({ from: 160, to: 219, count: 60, teeOff: 1, headEmpty: 1 });
    expect(win.from as number).toBeGreaterThan(latest);
  });
});

describe('outletSteadyViolations, the close graded at the Sink end', () => {
  function outletTrace(slotsAt: (i: number) => number[]): JamRecord[] {
    return Array.from({ length: 60 }, (_, i) =>
      rec({ t: 900 + i, tee: WORKING, inlet: [], up: [], outlet: slotsAt(i), outletPace: FAST }),
    );
  }

  it('passes a flowing outlet: items move and the Sink takes each one', () => {
    const cycle = [
      [3, 7, 11],
      [2, 6, 10],
      [1, 5, 9],
      [4, 8],
    ];
    expect(outletSteadyViolations(outletTrace((i) => cycle[i % 4]), IDS.outletId)).toEqual([]);
  });

  it('REFUSES a stopped Sink', () => {
    // The Sink stopped taking: the outlet's slot 0 fills and stays filled while its count
    // climbs from 3 to 12. Its occupancy still changes (nine times), so only the slot-0 and
    // growth clauses can see it.
    const v = outletSteadyViolations(
      outletTrace((i) => span(0, Math.min(11, 2 + Math.floor(i / 6)))),
      IDS.outletId,
    );
    expect(v).toContainEqual(expect.stringMatching(/slot 0/));
    expect(v).toContainEqual(expect.stringMatching(/grew/));
  });

  it('REFUSES an outlet that does not move', () => {
    const v = outletSteadyViolations(outletTrace(() => [5, 9]), IDS.outletId);
    expect(v).toContainEqual(expect.stringMatching(/changed on/));
  });
});

// ---------------------------------------------------------------------------
// THE RECORDED TRACES (plan 77-09): plan 77-03's D-15 measurement, from data in the repository.
// ---------------------------------------------------------------------------

/** A committed trace: the recorder's records trimmed to the fields the grader reads, the run's
 *  ids, and the line that run logged. Release traces also carry R and the fast outlet pace. */
interface Recorded {
  source: string;
  ids: JamIds;
  fastTicks?: number;
  R?: number;
  expected: string;
  records: JamRecord[];
}

function recorded(name: string): Recorded {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Recorded;
}

/** A copy of a RECORDED trace with the record at tick `t` patched: the Tee's state, the inlet's
 *  or the upstream's occupancy. The counter-traces below differ from real trace 1 in exactly
 *  what each one names. */
function editRecorded(
  trace: readonly JamRecord[],
  ids: JamIds,
  t: number,
  patch: { tee?: number; inlet?: number[]; up?: number[] },
): JamRecord[] {
  expect(trace.some((r) => r.t === t), `the recorded trace holds tick ${t}`).toBe(true);
  return trace.map((r) => {
    if (r.t !== t) return r;
    return {
      t,
      nodes: r.nodes.map((n) =>
        n[0] === ids.teeId && patch.tee !== undefined ? ([n[0], n[1], patch.tee] as [number, number, number]) : n,
      ),
      belts: r.belts.map((b) => {
        if (b[0] === ids.inletId && patch.inlet !== undefined) return [b[0], b[1], [...patch.inlet], b[3]];
        if (b[0] === ids.upstreamId && patch.up !== undefined) return [b[0], b[1], [...patch.up], b[3]];
        return b;
      }),
    };
  });
}

/** Grade a recorded release trace exactly as leg 3 grades its release. */
function gradeRecorded(rec: Recorded) {
  expect(rec.fastTicks, `${rec.source} carries the fast outlet pace`).toBeDefined();
  return gradeReleaseOrder(rec.records, rec.ids, rec.fastTicks as number);
}

describe("the recorded traces of plan 77-03's D-15 measurement", () => {
  for (const n of [1, 2, 3]) {
    it(`recorded release trace ${n} reproduces its RELEASE_ORDER line`, () => {
      const rec = recorded(`77-release-trace-${n}.json`);
      const grade = gradeRecorded(rec);
      expect(releaseOrderLine(grade)).toBe(rec.expected);
      expect(grade.R).toBe(rec.R);
      expect(frontFirstViolations(grade), 'a release that ran front first grades clean').toEqual([]);
    });
  }

  for (const n of [1, 2, 3]) {
    it(`recorded jam trace ${n} reproduces its PSEUDO_R line`, () => {
      const rec = recorded(`77-jam-trace-${n}.json`);
      expect(pseudoRLine(rec.records, rec.ids)).toBe(rec.expected);
      expect(rec.expected, 'no drip in the measured jam grades front first').toMatch(/ frontFirst=0$/);
    });
  }

  // CUT REASON (the ruling of 2026-10-08). The maintainers overturned named deviation A1 and leg 3's
  // "clears from the front" is cut: the front-first order is a sim-clock fact of about 50 ms, and the
  // line the eye watches thins from the Source end. Both halves of that reason, on every committed
  // release of the measurement: the front frees 3 ticks (50 ms at 60 ticks per second) before the
  // belt behind first moves, and the six run tiles thin one after another from the Source end, the
  // first more than 2 s after the release and the tile touching the Tee last.
  for (const n of [1, 2, 3]) {
    it(`CUT REASON (maintainer ruling) on recorded release trace ${n}: a 3-tick order, a line thinning from the Source end`, () => {
      const rec = recorded(`77-release-trace-${n}.json`);
      const grade = gradeRecorded(rec);
      expect(grade.frontFree, 'the front frees').not.toBeNull();
      expect(grade.junction, 'the belt behind moves').not.toBeNull();
      expect((grade.junction as number) - (grade.frontFree as number), 'front free to the belt behind, in ticks').toBe(3);
      const thin = thinningTicks(rec.records, rec.ids);
      expect(thin.every((t) => t !== null), 'every run tile thinned in the recording').toBe(true);
      const ticks = thin as number[];
      // `thinningTicks` lists the run tail (the Source end) to head (the tile touching the Tee).
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i], `tile ${i} thins after tile ${i - 1}, nearer the Source`).toBeGreaterThan(ticks[i - 1]);
      }
      expect(ticks[0] - (rec.R as number), 'the Source end thins more than 2 s (120 ticks) after R').toBeGreaterThan(120);
    });
  }

  // The three counter-traces, rebuilt from REAL release trace 1 (R 2290, the recorder missed
  // 2288 and 2289, so the record before R is 2287; FRONT FREE 2291, the junction 2294).

  it('REFUSES upstream shifted at R with its tail refilled (from real release trace 1)', () => {
    // The record before R (2287) stays the packed jam. At R the Tee still reads BACKED_UP with the
    // inlet's head taken (1..11); at R+1 the inlet reads 0..11 again, its count rose: the junction
    // delivered, while the upstream reads 0..11 in both records (shifted, its tail refilled: set
    // equality cannot see that move). FRONT FREE comes at R+2, the trace's own 2292.
    const rec = recorded('77-release-trace-1.json');
    let trace = editRecorded(rec.records, rec.ids, 2290, { tee: BACKED_UP, inlet: span(1, 11) });
    trace = editRecorded(trace, rec.ids, 2291, { tee: BACKED_UP, inlet: FULL });
    const grade = gradeReleaseOrder(trace, rec.ids, rec.fastTicks as number);
    expect({ R: grade.R, junction: grade.junction, frontFree: grade.frontFree, dripRefill: grade.dripRefill }).toEqual({
      R: 2290,
      junction: 2291,
      frontFree: 2292,
      dripRefill: null,
    });
    expect(grade.wrongway).toBe(1);
    expect(frontFirstViolations(grade)).toContainEqual(expect.stringMatching(/at or before FRONT FREE/));
  });

  it('REFUSES junction delivery in the front-free record (from real release trace 1)', () => {
    const rec = recorded('77-release-trace-1.json');
    const trace = editRecorded(rec.records, rec.ids, 2291, { up: span(1, 11) });
    const grade = gradeReleaseOrder(trace, rec.ids, rec.fastTicks as number);
    expect({ frontFree: grade.frontFree, junction: grade.junction, witness: grade.witness }).toEqual({
      frontFree: 2291,
      junction: 2291,
      witness: 0,
    });
    expect(frontFirstViolations(grade)).toContainEqual(expect.stringMatching(/at or before FRONT FREE/));
  });

  it('REFUSES front never frees (from real release trace 1)', () => {
    const rec = recorded('77-release-trace-1.json');
    let trace: JamRecord[] = rec.records;
    for (const r of rec.records) if (r.t >= 2290) trace = editRecorded(trace, rec.ids, r.t, { tee: BACKED_UP });
    const grade = gradeReleaseOrder(trace, rec.ids, rec.fastTicks as number);
    expect(grade.frontFree).toBeNull();
    expect(grade.wrongway).toBe(1);
    expect(frontFirstViolations(grade)).toContainEqual(expect.stringMatching(/^no FRONT FREE/));
  });
});

// ---------------------------------------------------------------------------
// THE DRIP IN FLIGHT AT R (the 77-03 refuter round, refuter 4). Plan 77-03 cut leg 3's "clears
// from the front" clause on two correct releases graded wrong-way: `77-release-trace-wrongway-1.json`
// (extra run 7) and `-2.json` (B12-close's release). In both the record before R shows the inlet
// short of full, a drip part-way through, so the upstream's next delivery was that drip's refill,
// scheduled before R, and the grader called it the release reaching the junction. The release's
// own delivery is the second one after that record (jamGrading.ts, "A DRIP IN FLIGHT AT R"); a
// tick no record shows counts as a delivery unless the core rules it out, so the rule can only
// make a grade stricter. `77-release-trace-hidden-refill.json` is the release of this round's
// first live run, where the recorder missed the tick the refill may have used.
// ---------------------------------------------------------------------------

const DRIP_TRACES: Record<string, string> = {
  '77-release-trace-wrongway-1.json':
    'RELEASE_ORDER R=2286 teeOff=2286 frontFree=2287 junction=2290 missed=2 witness=3 wrongway=0 dripRefill=2285 hidden=1',
  '77-release-trace-wrongway-2.json':
    'RELEASE_ORDER R=2206 teeOff=2208 frontFree=2209 junction=2212 missed=1 witness=3 wrongway=0 dripRefill=2206 hidden=0',
  '77-release-trace-hidden-refill.json':
    'RELEASE_ORDER R=2287 teeOff=2287 frontFree=2287 junction=2290 missed=2 witness=3 wrongway=0 dripRefill=2286 hidden=1',
  '77-release-trace-refill-at-b.json':
    'RELEASE_ORDER R=2249 teeOff=2249 frontFree=2249 junction=2252 missed=2 witness=3 wrongway=0 dripRefill=2246 hidden=0',
};

/**
 * A release landing on a drip in flight, modelled on wrongway-1 with no tick missed. B (1647):
 * the Tee has taken the inlet's head (1..11), its tail still occupied, so no delivery can come at
 * 1648. R (1648): the fast pace, the inlet shifted (0..10), its tail free. 1649: the drip's refill
 * leaves the upstream. 1650: the Tee off with the inlet's head empty (FRONT FREE). 1653: the
 * release's own delivery. Witness 1650..1652.
 */
function dripAtRTrace(): JamRecord[] {
  const out: JamRecord[] = [];
  for (let t = 1640; t < 1647; t++) out.push(rec({ t, tee: BACKED_UP, inlet: FULL, up: FULL }));
  out.push(rec({ t: 1647, tee: BACKED_UP, inlet: span(1, 11), up: FULL }));
  out.push(rec({ t: 1648, tee: WORKING, inlet: span(0, 10), up: FULL, outletPace: FAST }));
  out.push(rec({ t: 1649, tee: WORKING, inlet: FULL, up: span(1, 11), outletPace: FAST }));
  out.push(rec({ t: 1650, tee: WORKING, inlet: span(1, 11), up: FULL, outletPace: FAST }));
  out.push(rec({ t: 1651, tee: WORKING, inlet: span(0, 10), up: FULL, outletPace: FAST }));
  out.push(rec({ t: 1652, tee: WORKING, inlet: span(1, 10), up: FULL, outletPace: FAST }));
  for (let t = 1653; t < 1700; t++) {
    out.push(
      rec({
        t,
        tee: WORKING,
        inlet: t % 2 === 1 ? span(1, 11) : span(0, 10),
        up: t % 2 === 1 ? span(1, 11) : span(0, 10),
        outletPace: FAST,
      }),
    );
  }
  return out;
}

describe('the drip in flight at R (the 77-03 refuter round)', () => {
  it('DRIP IN FLIGHT: the releases graded wrong-way or unobservable before this rule grade front first', () => {
    for (const [name, line] of Object.entries(DRIP_TRACES)) {
      const rec = recorded(name);
      const grade = gradeRecorded(rec);
      const R = grade.R as number;
      const i = rec.records.findIndex((r) => r.t >= R);
      const inletBefore = rec.records[i - 1].belts.find((b) => b[0] === rec.ids.inletId)![2];
      const upBefore = rec.records[i - 1].belts.find((b) => b[0] === rec.ids.upstreamId)![2];
      expect(
        inletBefore.length < 12 || !upBefore.includes(0),
        `${name}: the record before R shows a drip in flight (the inlet short, or the refill landing on it)`,
      ).toBe(true);
      expect(rec.expected, `${name}: the run itself logged it wrong-way or unobservable`).toMatch(
        / wrongway=1$| unobservable="/,
      );
      expect(releaseOrderLine(grade), name).toBe(line);
      expect(frontFirstViolations(grade), name).toEqual([]);
    }
  });

  it("DRIP IN FLIGHT (d1, d1'): every delivery in the committed traces follows a record with the inlet tail free, two after one with a free slot", () => {
    let seen = 0;
    let seen2 = 0;
    for (const name of [...Object.keys(DRIP_TRACES), '77-release-trace-1.json', '77-release-trace-2.json', '77-release-trace-3.json']) {
      if (DRIP_TRACES[name] === undefined && !name.startsWith('77-release-trace-')) continue;
      const rec = recorded(name);
      const byTick = new Map(rec.records.map((r) => [r.t, r]));
      for (const r of rec.records) {
        const up = r.belts.find((b) => b[0] === rec.ids.upstreamId)![2];
        const prev = byTick.get(r.t - 1);
        if (up.includes(0) || prev === undefined) continue;
        // A delivery: the head was there a tick ago. Late in a release the upstream thins and its
        // head reads empty with nothing delivered; those are not deliveries.
        if (!prev.belts.find((b) => b[0] === rec.ids.upstreamId)![2].includes(0)) continue;
        seen++;
        const prevInlet = prev.belts.find((b) => b[0] === rec.ids.inletId)![2];
        expect(prevInlet.includes(11), `${name}: delivery at ${r.t} after a record with the inlet tail occupied`).toBe(false);
        const prev2 = byTick.get(r.t - 2);
        if (prev2 !== undefined) {
          seen2++;
          const prev2Inlet = prev2.belts.find((b) => b[0] === rec.ids.inletId)![2];
          expect(prev2Inlet.length, `${name}: delivery at ${r.t} two ticks after a record with the inlet full (d1')`).toBeLessThan(12);
        }
      }
    }
    expect(seen, 'deliveries with the record before them present').toBeGreaterThan(100);
    expect(seen2, 'deliveries with the record two before them present').toBeGreaterThan(100);
  });

  it('DRIP IN FLIGHT: a synthetic release on a drip grades front first, the refill skipped', () => {
    const grade = gradeReleaseOrder(dripAtRTrace(), IDS, FAST);
    expect(grade).toMatchObject({
      R: 1648,
      frontFree: 1650,
      junction: 1653,
      witness: 3,
      wrongway: 0,
      unobservable: null,
      dripRefill: { refill: 1649, hidden: 0 },
    });
    expect(frontFirstViolations(grade)).toEqual([]);
  });

  it('DRIP IN FLIGHT: the refill in a tick no record shows still counts once, and the order holds', () => {
    const grade = gradeReleaseOrder(
      dripAtRTrace().filter((r) => r.t !== 1649),
      IDS,
      FAST,
    );
    expect(grade).toMatchObject({ frontFree: 1650, junction: 1653, wrongway: 0, dripRefill: { refill: 1649, hidden: 1 } });
    expect(frontFirstViolations(grade)).toEqual([]);
  });

  it('DRIP IN FLIGHT REFUSES a missed tick that could hold the release\'s own delivery before FRONT FREE', () => {
    // 1650 to 1652 missed. 1650 and 1651 cannot hold a delivery: the inlet was full at 1649, so its
    // tail was occupied there (d1) and it could not free it by 1650 (d1'). 1652 can (the records
    // before it are missing), so the release may have reached the upstream before FRONT FREE at
    // 1653. The rule counts it and grades the release wrong-way rather than guess.
    const grade = gradeReleaseOrder(
      dripAtRTrace().filter((r) => r.t < 1650 || r.t > 1652),
      IDS,
      FAST,
    );
    expect(grade).toMatchObject({ frontFree: 1653, junction: 1652, wrongway: 1, dripRefill: { refill: 1649, hidden: 1 } });
    expect(frontFirstViolations(grade)).toContainEqual(expect.stringMatching(/at or before FRONT FREE/));
  });

  it('DRIP IN FLIGHT REFUSES a release whose own junction delivery comes before FRONT FREE', () => {
    // The rule removes the drip's refill only. Here the Tee stays BACKED_UP at 1650 and 1651, the
    // release's own delivery leaves the upstream at 1651, two ticks after the refill, and FRONT
    // FREE comes only at 1652.
    let trace = edit(dripAtRTrace(), 1650, { tee: BACKED_UP });
    trace = edit(trace, 1651, { tee: BACKED_UP, inlet: FULL, up: span(1, 11) });
    trace = edit(trace, 1652, { inlet: span(1, 11) });
    const grade = gradeReleaseOrder(trace, IDS, FAST);
    expect({ frontFree: grade.frontFree, junction: grade.junction, dripRefill: grade.dripRefill }).toEqual({
      frontFree: 1652,
      junction: 1651,
      dripRefill: { refill: 1649, hidden: 0 },
    });
    expect(grade.wrongway).toBe(1);
    expect(frontFirstViolations(grade)).toContainEqual(expect.stringMatching(/at or before FRONT FREE/));
  });

  it('DRIP IN FLIGHT REFUSES a release whose second delivery never comes within the recording', () => {
    const trace = dripAtRTrace()
      .filter((r) => r.t <= 1652)
      .map((r) => r);
    const grade = gradeReleaseOrder(trace, IDS, FAST);
    expect(grade.junction).toBeNull();
    expect(frontFirstViolations(grade)).toContainEqual(expect.stringMatching(/never reached the upstream belt/));
  });

  it('DRIP IN FLIGHT does not apply when the record before R is the packed jam', () => {
    const grade = gradeReleaseOrder(forwardTrace(), IDS, FAST);
    expect(grade.dripRefill).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE GAUGE, GRADED BY THE TICK IT WAS DRAWN FROM (plan 77-07, phase 77 D-04).
// ---------------------------------------------------------------------------
//
// The recorder reads the model and the Tee's drawn gauge form in one breath, but the model moves
// as each packet lands and the gauge is plotted only in the render loop's draw, so a record at
// tick T usually carries the form drawn for T-1 (77-MUTATION-PROOF.md, "Plan 77-07 gauge lag
// measurement": lag 1 on about four records in five, up to 4). These cases pin that every form is
// graded by its own `drawnAtTick`, never by the tick of the record that carried it.

/** `r` carrying the Tee's form drawn at `drawnAtTick`, merged or not. */
function withForm(r: JamRecord, drawnAtTick: number, merged: boolean): JamRecord {
  return {
    ...r,
    g: [[IDS.teeId, { instructions: merged ? 1 : 3, width: merged ? 25 : 18, merged, drawnAtTick }]],
  };
}

/** A release around the witness tick W = 103: merged forms drawn before W, carried one record late. */
function gaugeTrace(lastMergedDrawn: number): JamRecord[] {
  const out: JamRecord[] = [];
  for (let t = 98; t <= 108; t++) {
    const drawn = t - 1;
    out.push(withForm(rec({ t, tee: t < 103 ? BACKED_UP : WORKING, inlet: FULL, up: FULL }), drawn, drawn <= lastMergedDrawn));
  }
  return out;
}

describe('the gauge graded by the tick it was drawn from (plan 77-07)', () => {
  it('ALIGNS a merged bar drawn before the witness, recorded beside it', () => {
    // The record AT the witness tick 103 carries the merged form drawn at 102; every form drawn
    // at or after 103 is broken. Keyed by drawn tick, nothing merged lies at or after 103.
    const trace = gaugeTrace(102);
    expect(trace.find((r) => r.t === 103)?.g?.[0][1], 'precondition: the witness record carries a merged form').toMatchObject({
      merged: true,
      drawnAtTick: 102,
    });
    expect(gaugeReleaseViolations(gaugeFormsByDrawnTick(trace, IDS.teeId), 103)).toEqual([]);
  });

  it('REFUSES a merged bar drawn at or after the witness tick', () => {
    const v = gaugeReleaseViolations(gaugeFormsByDrawnTick(gaugeTrace(103), IDS.teeId), 103);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/merged bar drawn at tick 103/);
  });

  it('REFUSES no frame drawn after the witness', () => {
    // Every form drawn before the witness: an empty set at or after it can never pass.
    const trace = gaugeTrace(90).filter((r) => r.t <= 103);
    const v = gaugeReleaseViolations(gaugeFormsByDrawnTick(trace, IDS.teeId), 103);
    expect(v).toEqual([expect.stringMatching(/^no frame drawn at or after tick 103/)]);
  });

  it('the merged-bar fraction over drawn ticks inside a window counts each drawn tick once, however many records carried it', () => {
    // Three records carry the merged form drawn at 50 (the renderer did not draw between them),
    // one carries the broken form drawn at 51: two drawn ticks, one merged, 0.5, never 0.75.
    const r = (t: number, drawn: number, merged: boolean): JamRecord =>
      withForm(rec({ t, tee: BACKED_UP, inlet: FULL, up: FULL }), drawn, merged);
    const trace = [r(51, 50, true), r(52, 50, true), r(53, 50, true), r(54, 51, false)];
    const forms = gaugeFormsByDrawnTick(trace, IDS.teeId);
    expect(forms.map((f) => f.drawnAtTick)).toEqual([50, 51]);
    expect(mergedFraction(forms, 50, 51)).toEqual({ drawn: 2, merged: 1, fraction: 0.5 });
    expect(mergedFraction(forms, 52, 60), 'no drawn tick in the window').toEqual({ drawn: 0, merged: 0, fraction: 0 });
  });
});

// THE MERGED BAR AGAINST THE DRIPS (plan 84-18, push 5; the D-12 approval "Check against
// drips"). Run 4 (CI, 2026-10-18) read leg 3's merged bar on 15 of 18 drawn frames, 0.833 under
// the old 0.85 share. Measured on four local traces (84-EVIDENCE.md), the bar is broken on exactly
// the drip tick, the one tick the Tee reads WORKING, and merged on every other; the drips fall
// every outlet pace (20 ticks) on one tick of that cycle. So a frame drawn on a drip tick may show
// the bar broken, and how many such frames a page draws depends on its frame rate, not on the
// product. These cases grade the bar against the drips instead.
describe('mergedBarAgainstDrips, the merged bar graded against the drips (plan 84-18)', () => {
  const PACE = 20;
  const PHASE = 2;
  const FROM = 4137;
  const TO = 4316;
  /** Records for every tick of the window but `missing`, the Tee WORKING on the drip ticks. */
  function dripRecords(missing: readonly number[] = [], phase = PHASE): JamRecord[] {
    const out: JamRecord[] = [];
    for (let t = FROM; t <= TO; t++) {
      if (missing.includes(t)) continue;
      out.push(rec({ t, tee: t % PACE === phase ? WORKING : BACKED_UP, inlet: FULL, up: FULL, outletPace: PACE }));
    }
    return out;
  }
  const form = (t: number, merged: boolean): GaugeForm => ({ instructions: merged ? 1 : 3, width: merged ? 40 : 30, merged, drawnAtTick: t });
  /** CI's shape: 18 drawn frames, about one every 10 ticks, three of them on drip ticks. */
  const CI_DRAWN = [4142, 4151, 4160, 4170, 4182, 4190, 4199, 4210, 4219, 4230, 4241, 4250, 4262, 4271, 4280, 4290, 4299, 4310];
  const ciForms = (broken: readonly number[]): GaugeForm[] => CI_DRAWN.map((t) => form(t, !broken.includes(t)));
  const DRIP_FRAMES = [4142, 4182, 4262];

  it("PASSES run 4's shape: 18 drawn frames, the bar broken on the 3 drawn on drip ticks (one of them a tick the recorder missed)", () => {
    expect(CI_DRAWN.length).toBe(18);
    expect(DRIP_FRAMES.every((t) => t % PACE === PHASE)).toBe(true);
    const g = mergedBarAgainstDrips(dripRecords([4182]), ciForms(DRIP_FRAMES), IDS, FROM, TO);
    expect(g.violations).toEqual([]);
    expect({ drawn: g.drawn, merged: g.merged, brokenOnDrips: g.brokenOnDrips, pace: g.pace, phase: g.phase }).toEqual({
      drawn: 18,
      merged: 15,
      brokenOnDrips: 3,
      pace: PACE,
      phase: PHASE,
    });
  });

  it('REFUSES the bar kept broken between drips (the mutant): a frame off the drip ticks shows it broken', () => {
    const g = mergedBarAgainstDrips(dripRecords([4182]), ciForms([...DRIP_FRAMES, 4190]), IDS, FROM, TO);
    expect(g.violations).toEqual([expect.stringMatching(/^bar broken at tick 4190, between drips/)]);
  });

  it('REFUSES drips that fall at two phases of the outlet pace (not one drip per outlet advance)', () => {
    const recs = dripRecords().map((r) => (r.t === 4171 ? rec({ t: 4171, tee: WORKING, inlet: FULL, up: FULL, outletPace: PACE }) : r));
    const g = mergedBarAgainstDrips(recs, ciForms(DRIP_FRAMES), IDS, FROM, TO);
    expect(g.violations).toContainEqual(expect.stringMatching(/^drips at more than one tick of the outlet pace/));
  });

  it('REFUSES a bar never merged, even when every frame lands on a drip tick', () => {
    const forms = [4142, 4162, 4182].map((t) => form(t, false));
    const g = mergedBarAgainstDrips(dripRecords(), forms, IDS, FROM, TO);
    expect(g.violations).toContainEqual(expect.stringMatching(/^no merged bar drawn/));
  });

  const TRACE = JSON.parse(readFileSync(new URL('./fixtures/84-18-jam-gauge-trace.json', import.meta.url), 'utf8')) as {
    ids: JamIds;
    jamFrom: number;
    jamTo: number;
    expected: string;
    records: JamRecord[];
  };

  it('PASSES the recorded steady jam (legs 1 to 3 unthrottled, 120 drawn frames, the bar broken on the 7 drip ticks)', () => {
    const forms = gaugeFormsByDrawnTick(TRACE.records, TRACE.ids.teeId);
    const g = mergedBarAgainstDrips(TRACE.records, forms, TRACE.ids, TRACE.jamFrom, TRACE.jamTo);
    expect(g.violations).toEqual([]);
    const f = mergedFraction(forms, TRACE.jamFrom, TRACE.jamTo);
    expect(`GAUGE_JAM drawn=${f.drawn} merged=${f.merged} fraction=${f.fraction.toFixed(3)} from=${TRACE.jamFrom} to=${TRACE.jamTo}`).toBe(TRACE.expected);
    expect({ pace: g.pace, phase: g.phase, brokenOnDrips: g.brokenOnDrips }).toEqual({ pace: 20, phase: 2, brokenOnDrips: 7 });
  });

  it('REFUSES the recorded steady jam with the bar broken on one frame between drips (the mutant on a real trace)', () => {
    const forms = gaugeFormsByDrawnTick(TRACE.records, TRACE.ids.teeId).map((f) => (f.drawnAtTick === 2090 ? { ...f, merged: false } : f));
    expect(forms.some((f) => f.drawnAtTick === 2090)).toBe(true);
    const g = mergedBarAgainstDrips(TRACE.records, forms, TRACE.ids, TRACE.jamFrom, TRACE.jamTo);
    expect(g.violations).toEqual([expect.stringMatching(/^bar broken at tick 2090, between drips/)]);
  });
});
