// jamGrading.ts - the PURE grader for leg 3 of the composed walk (plan 77-03, phase 77 D-14,
// D-15, D-16). Plain data in, plain data out. It imports NOTHING, so it carries no product source
// and no Playwright, and `src/gates/jamGrading.test.ts` grades every rule here on hand-written
// traces and counter-traces.
//
// ===========================================================================
// WHAT IT READS
// ===========================================================================
//
// The in-page tick recorder's records (`oracle.ts` `startTickRecorder`, plan 77-02): per recorded
// sim tick, every node `[id, kind, state]` and every belt `[id, ticksPerSlot, occupiedSlots,
// docks]`. Slot 0 is a belt's HEAD, its deliver end. The packet carries NO item identity: a
// belt's occupancy is a set of slot indices and nothing says which item sits in which slot
// (`frontend/src/render/sceneState.ts`, the `resolveFromSlots` docblock). The recorder can miss
// a tick (measured: R-2 and R-1 on every research run, while the Apply click holds the main
// thread). No rule here needs a particular tick to be present; the one rule that reads tick
// numbers, the drip-in-flight rule below, says how far apart two records may be before it calls
// the order unobservable, and why.
//
// ===========================================================================
// HOW THE RELEASE REACHES THE BELT BEHIND THE INLET, AND WHICH SIGNAL SEES IT
// ===========================================================================
//
// The run is two belts: the UPSTREAM (drawn off the Source in leg 2) and the INLET (drawn on from
// its end, its Head docked into the Tee in leg 3). A "junction delivery" is the upstream's head
// item moving into the inlet's tail slot. Read from the core, at the start revision:
//
//   1. A belt's own step ADVANCES first, then ADMITS one inbox item into its tail if the tail is
//      free (`crates/fabrico-core/src/belt.rs:99-112`). The advance is one ascending pass
//      (`crates/fabrico-core/src/belt_slots.rs:226-232` `advance_slots`): an item moves only into
//      a free slot ahead of it, so a packed run with its head occupied does not move at all, and
//      a packed run with its head free shifts forward by exactly one slot, rigidly.
//   2. The fold delivers a belt's head AFTER that belt's own step, and into a downstream belt
//      only when that belt's tail slot is already free (`crates/fabrico-core/src/tick.rs:1772-1822`,
//      the belt-to-belt arm).
//   3. The fold steps nodes in ascending id (`tick.rs:22-26` step 3, `tick.rs:139`
//      `drain_active_sorted`). On this board the ids are minted in creation order: Source, then
//      upstream, then inlet (leg 2), then Tee, Sink, outlet (leg 3). So the upstream steps BEFORE
//      the inlet in every tick. A tail slot the inlet frees by its own advance at tick t is
//      therefore seen by the upstream only at tick t+1: "ACROSS a belt->belt boundary a 1-tick
//      junction stutter is possible" (`tick.rs:1765-1770`).
//
// So in the packet of the tick a junction delivery happens:
//
//   (a) THE UPSTREAM'S OCCUPANCY CHANGES. Its own step ran first (point 1): its head was
//       occupied, so its advance moved nothing, and its tail, full, admitted nothing. Then the
//       fold took its head (point 2). Its slot 0 reads EMPTY in this packet, and it cannot be
//       refilled before the next packet, because its next advance and its next admit belong to
//       its next step. So (a) fires, PROVIDED the upstream's slot 0 was occupied in the last
//       record before R. If it was already empty there (a drip's own delivery landing on that
//       record), the upstream's next change is its own refill, not the release arriving; plan
//       77-03 called that order unobservable, and the drip rule below now reads it.
//   (b) THE INLET'S COUNT RISES, unless the inlet also delivered its own head to the Tee in the
//       same tick (its step comes after the upstream's, point 3).
//   (c) THE INLET'S HIGHEST OCCUPIED SLOT RISES, unless the inlet's whole run, the new tail item
//       with it, shifted forward on that same tick, which needs its slot 0 free at its advance.
//
// (b) and (c) can both read unchanged in one packet: a packed inlet with its head free shifts,
// delivers its new head to the Tee and gains the upstream's item, all in one tick, and its count
// and highest slot are what they were. That is why the grader never relies on them alone, and
// why it never takes upstream occupancy-set EQUALITY as proof the upstream did not move: a belt
// that shifted and had its tail refilled reads the same set before and after.
//
// THE GRADER SEES THE JUNCTION THROUGH THE STUTTER ALONE. What makes (a) reliable is points 1 and
// 3 together: the upstream's head leaves in one tick and its refill can only come in a later one.
// Without that (a fold that delivered every belt's head, then advanced and admitted every belt,
// in phases within one tick: the "phased advance-all/deliver-all/admit-all fold" `tick.rs:1769`
// defers), the inlet would lose its head and gain the upstream's item in one tick, so its count
// and highest slot read unchanged, while the upstream shifted and the Source refilled its tail in
// the same tick, so its set reads unchanged too. The delivery would leave no trace in any packet.
// A future core change of that kind silently blinds this grader; that is why the discrimination
// check (77-MUTATION-PROOF.md, "Plan 77-03 D-15 measurement") stands between this grader and any
// assertion built on it.
//
// THE DRIP. In a steady jam the Tee emits one item per outlet advance, drops to 15 of 16, reads
// `WORKING` for a tick, takes the inlet's head (slot 0 empty for about 2 ticks), and the junction
// refills behind it (77-RESEARCH.md, "The jam is a drip, not a stop"). If "the Tee is off
// BACKED_UP" and "the inlet's slot 0 is empty" ever shared a record inside a drip, FRONT FREE
// would come before the junction about once every 20 ticks with NO release at all. `pseudoRLine`
// asks the grader about exactly those moments: an R placed inside the steady jam, where nothing
// was released. A grader that calls those front-first is grading the scheduler's every drip, not
// the release. MEASURED on the live host (plan 77-03, `t1-jam.json`): they never share a record.
// The Tee reads WORKING on the tick it emits while the inlet's head is still there (the inlet
// steps BEFORE the Tee, point 3, so its delivery lands on the next tick), and when the head
// empties the Tee is already back on BACKED_UP. Only a release, where the Tee keeps emitting
// faster than the inlet refills it, holds the Tee off while the head is empty.
//
// A DRIP IN FLIGHT AT R (the 77-03 refuter round, refuter 4). The release can land while a drip
// is part-way through. The record before R (B) then shows either the inlet short of full (its head
// taken by the Tee, or its tail already free) or the upstream's slot 0 empty (the drip's refill
// landing on B itself). A free inlet slot reaches the inlet's tail whatever the outlet does, so
// the upstream's next delivery is the drip's REFILL, scheduled before R. Plan 77-03 graded that
// refill as the release reaching the junction and read 2 of 12 correct releases wrong-way
// (`77-release-trace-wrongway-1.json`, `-2.json`), and called a refill landing on B unobservable;
// the release's own junction delivery came 3 records after FRONT FREE in every one. So when B
// shows a drip in flight, the junction is the first junction delivery after B that is not a
// pending refill: the SECOND delivery after B when the inlet is short at B, the FIRST when B
// already shows the refill landed and the inlet full (`77-release-trace-refill-at-b.json`).
//
// The recorder misses ticks around R, so a delivery can fall in a tick no record shows. The rule
// never assumes it did not. Two facts from the core say where a delivery can be:
//   (d1) The upstream delivers at tick t only into a tail the inlet freed by tick t-1 (point 3:
//        the upstream steps first, so it sees the inlet's own advance one tick late). A record
//        at t-1 with the inlet's tail occupied rules out a delivery at t. MEASURED: every one of
//        the deliveries in the committed traces follows a record with the inlet's slot 11 free.
//  (d1') The inlet frees its tail at t-1 only by advancing into a free slot it held at the end of
//        t-2: its own step runs before the Tee takes its head (point 3), and nothing else frees a
//        slot ahead of it. A record at t-2 with the inlet full rules out a delivery at t.
//        MEASURED on the same deliveries.
//   (d2) The run advances only on ticks that are a multiple of its pace (`belt.rs`, `tick %
//        ticks_per_slot`), so the inlet frees its tail at most once per `pace` ticks, and two
//        deliveries are at least `pace` ticks apart.
// The rule takes every tick that COULD hold a delivery: a record with the upstream's slot 0 empty
// (a delivery shows that way in its own tick's record, point (a); late in the release the upstream
// thins and its head can read empty with no delivery, which only adds ticks), and every tick no
// record shows that (d1) does not rule out. The junction is the earliest of those ticks with
// another at least `pace` ticks before it (d2): a lower bound on the release's own delivery,
// because the set holds every real delivery and the release's is the second one. A lower bound
// can only move the junction EARLIER, so the rule can grade a correct release wrong-way when the
// recorder missed too much, never a wrong release front first. The line names the first possible
// delivery (the refill) and how many ticks no record shows it counted up to the junction
// (`dripRefill=<tick> hidden=<n>`).

/** One recorded tick, the recorder's own shape (`oracle.ts` `TickRecord`), restated here
 *  because this module imports nothing. `g` is present when the recorder ran with `gaugeOf`. */
export interface JamRecord {
  t: number;
  nodes: [number, number, number][];
  belts: [number, number, number[], { end: 'Head' | 'Tail'; node: number; port: number }[]][];
  g?: [number, GaugeForm | null][];
}

/** A load gauge's drawn form (`oracle.ts` `LoadGaugeFormFacts`, `MachineLayer.loadGaugeFormOn`),
 *  restated. `drawnAtTick` is the scene tick the render pass that plotted it read. */
export interface GaugeForm {
  instructions: number;
  width: number;
  merged: boolean;
  drawnAtTick: number;
}

/** The four handles leg 3 grades. */
export interface JamIds {
  teeId: number;
  /** The run's DOWNSTREAM belt, its Head docked into the Tee's In. */
  inletId: number;
  /** The run's first belt, drawn off the Source; its Head feeds the inlet's Tail. */
  upstreamId: number;
  /** The Tee's first Out to the Sink. Its slot 0 is the Sink end. */
  outletId: number;
}

/** `frontend/src/protocol/kinds.ts` `state_tag.BACKED_UP`, mirrored (never imported). */
const STATE_BACKED_UP = 3;
/** A run belt here is three tiles of four slots (leg 2's cells). */
const BELT_SLOTS = 12;
const SLOTS_PER_TILE = 4;
/** The inlet's tail slot, the junction end. */
const TAIL_SLOT = BELT_SLOTS - 1;
/** The pack boundaries, every tile edge of the six-tile run, front to back. */
const PACK_BOUNDARIES = [4, 8, 12, 16, 20, 24] as const;

function stateOf(r: JamRecord, id: number): number | undefined {
  return r.nodes.find((n) => n[0] === id)?.[2];
}

function slotsOf(r: JamRecord, id: number): number[] | undefined {
  return r.belts.find((b) => b[0] === id)?.[2];
}

function paceOf(r: JamRecord, id: number): number | undefined {
  return r.belts.find((b) => b[0] === id)?.[1];
}

function sameSlots(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

function highest(slots: readonly number[]): number {
  return slots.length === 0 ? -1 : Math.max(...slots);
}

/** The count of contiguous occupied slots from slot 0. */
function prefix(slots: readonly number[]): number {
  let n = 0;
  while (n < slots.length && slots[n] === n) n++;
  return n;
}

/** The fraction of `records` for which `pred` holds (0 for an empty list). */
function fraction(records: readonly JamRecord[], pred: (r: JamRecord) => boolean): number {
  if (records.length === 0) return 0;
  return records.filter(pred).length / records.length;
}

/** Tick numbers absent between consecutive records of `records[from..to]`, inclusive. */
function missedBetween(records: readonly JamRecord[], from: number, to: number): number {
  let n = 0;
  for (let i = Math.max(1, from + 1); i <= Math.min(to, records.length - 1); i++) {
    const gap = records[i].t - records[i - 1].t;
    if (gap > 1) n += gap - 1;
  }
  return n;
}

/** The release order, graded. Ticks or null; counts; a reason or null. */
export interface ReleaseGrade {
  /** The tick of R: the first record carrying the fast outlet pace, or the `rTick` record. */
  R: number | null;
  /** The first record at or after R in which the Tee is not `BACKED_UP`. */
  teeOff: number | null;
  /** FRONT FREE: the first record at or after R in which the Tee is not `BACKED_UP` AND the
   *  inlet's slot 0 is empty. */
  frontFree: number | null;
  /** The first record at or after R showing signal (a), (b) or (c). */
  junction: number | null;
  /** Ticks the recorder missed between the record before R and the later of FRONT FREE and the
   *  junction (or the recording's end when either never comes). */
  missed: number;
  /** Records at or after FRONT FREE and strictly before the junction record (to the end of the
   *  recording when the junction never comes). */
  witness: number;
  /** 1 when the junction record is at or before FRONT FREE, or FRONT FREE never comes. */
  wrongway: 0 | 1;
  /** Why the order cannot be read off this recording, or null. */
  unobservable: string | null;
  /** When the record before R showed a drip in flight: the tick of the drip's refill (the first
   *  possible delivery after that record when the inlet was short there, that record itself when
   *  the refill had landed on it) and how many of the deliveries counted up to the junction were
   *  possible ones in ticks no record shows. Null otherwise. */
  dripRefill: { refill: number; hidden: number } | null;
}

/**
 * The drip rule's junction (module docblock, "A DRIP IN FLIGHT AT R"), as a LOWER BOUND. Every
 * tick after the record before R that COULD hold a junction delivery: a record with the
 * upstream's slot 0 empty, or a tick no record shows that (d1) and (d1') do not rule out. That
 * set holds every real delivery. With a refill `pending` (the inlet short at B) the junction is
 * the earliest tick in it with another at least `pace` ticks before it (d2), never later than the
 * real second delivery; with none pending (the refill landed on B) it is the earliest tick in it.
 * `refill` is the earliest tick in the set when a refill is pending; `hidden` counts the ticks no
 * record shows, in the set, up to the junction. Null junction when the recording holds none.
 */
function deliveryAfterDrip(
  records: readonly JamRecord[],
  ids: JamIds,
  ri: number,
  pending: number,
): { refill: number | null; junction: number | null; hidden: number } {
  const byTick = new Map<number, JamRecord>();
  for (const r of records) byTick.set(r.t, r);
  const pace = Math.max(1, paceOf(records[ri - 1], ids.inletId) ?? 1);
  const from = records[ri - 1].t + 1;
  const to = records[records.length - 1].t;
  const possible: { t: number; hidden: boolean }[] = [];
  for (let t = from; t <= to; t++) {
    const r = byTick.get(t);
    if (r !== undefined) {
      if (!(slotsOf(r, ids.upstreamId) ?? []).includes(0)) possible.push({ t, hidden: false });
      continue;
    }
    const prev = byTick.get(t - 1);
    if (prev !== undefined && (slotsOf(prev, ids.inletId) ?? []).includes(TAIL_SLOT)) continue; // (d1)
    const prev2 = byTick.get(t - 2);
    if (prev2 !== undefined && (slotsOf(prev2, ids.inletId) ?? []).length >= BELT_SLOTS) continue; // (d1')
    possible.push({ t, hidden: true });
  }
  const refill = pending > 0 ? (possible[0]?.t ?? null) : null;
  const j =
    pending === 0
      ? possible.length > 0
        ? 0
        : -1
      : refill === null
        ? -1
        : possible.findIndex((d) => d.t - refill >= pace);
  const junction = j < 0 ? null : possible[j].t;
  return {
    refill,
    junction,
    hidden: junction === null ? 0 : possible.filter((d) => d.hidden && d.t <= junction).length,
  };
}

function gradeAt(records: readonly JamRecord[], ids: JamIds, ri: number): ReleaseGrade {
  const none: ReleaseGrade = {
    R: null,
    teeOff: null,
    frontFree: null,
    junction: null,
    missed: 0,
    witness: 0,
    wrongway: 1,
    unobservable: null,
    dripRefill: null,
  };
  if (ri < 0 || ri >= records.length) return none;
  const R = records[ri].t;
  if (ri === 0) {
    return { ...none, R, unobservable: 'no record before R, so (a) has nothing to compare with' };
  }
  const before = records[ri - 1];
  const upBefore = slotsOf(before, ids.upstreamId);
  const inletBefore = slotsOf(before, ids.inletId);
  if (upBefore === undefined || inletBefore === undefined) {
    return { ...none, R, unobservable: 'the record before R does not carry the upstream or the inlet' };
  }
  // A DRIP IN FLIGHT AT R (module docblock): the first delivery after B that is not a pending refill.
  const pending = inletBefore.length < BELT_SLOTS ? 1 : 0;
  const drip = !upBefore.includes(0) || pending > 0;
  const dripJunction = drip ? deliveryAfterDrip(records, ids, ri, pending) : null;
  let teeOffI = -1;
  let frontFreeI = -1;
  let junctionI = drip ? -2 : -1;
  for (let i = ri; i < records.length; i++) {
    const r = records[i];
    const off = stateOf(r, ids.teeId) !== STATE_BACKED_UP;
    const inlet = slotsOf(r, ids.inletId) ?? [];
    if (teeOffI < 0 && off) teeOffI = i;
    if (frontFreeI < 0 && off && !inlet.includes(0)) frontFreeI = i;
    if (junctionI === -1) {
      const prevInlet = slotsOf(records[i - 1], ids.inletId) ?? [];
      const a = !sameSlots(slotsOf(r, ids.upstreamId) ?? [], upBefore);
      const b = inlet.length > prevInlet.length;
      const c = highest(inlet) > highest(prevInlet);
      if (a || b || c) junctionI = i;
    }
    if (teeOffI >= 0 && frontFreeI >= 0 && junctionI !== -1) break;
  }
  if (junctionI === -2) junctionI = -1;
  // The junction as a TICK: the record's, or the drip rule's earliest possible delivery, which
  // can be a tick no record shows.
  const junctionT: number | null = drip
    ? (dripJunction?.junction ?? null)
    : junctionI < 0
      ? null
      : records[junctionI].t;
  const frontFreeT = frontFreeI < 0 ? null : records[frontFreeI].t;
  const end = records.length - 1;
  const lastBefore = (t: number): number => {
    let j = -1;
    for (let k = 0; k < records.length && records[k].t <= t; k++) j = k;
    return j;
  };
  const spanEnd =
    frontFreeI < 0 || junctionT === null ? end : Math.max(frontFreeI, lastBefore(junctionT));
  const witness =
    frontFreeT === null
      ? 0
      : records.filter((r) => r.t >= frontFreeT && (junctionT === null || r.t < junctionT)).length;
  const wrongway: 0 | 1 =
    frontFreeT === null || (junctionT !== null && junctionT <= frontFreeT) ? 1 : 0;
  return {
    R,
    teeOff: teeOffI < 0 ? null : records[teeOffI].t,
    frontFree: frontFreeI < 0 ? null : records[frontFreeI].t,
    junction: junctionT,
    missed: missedBetween(records, ri - 1, spanEnd),
    witness,
    wrongway,
    unobservable: null,
    dripRefill:
      dripJunction === null
        ? null
        : { refill: dripJunction.refill ?? before.t, hidden: dripJunction.hidden },
  };
}

/**
 * Grade the release order. R is the first record whose outlet carries `fastTicks` ticks per slot
 * or, when `rTick` is given, the record at that tick (the first record at or after it when that
 * tick was missed): the PSEUDO-R form `pseudoRLine` uses. See the module docblock for FRONT FREE,
 * the junction's three signals and the witness.
 */
export function gradeReleaseOrder(
  records: readonly JamRecord[],
  ids: JamIds,
  fastTicks: number,
  rTick?: number,
): ReleaseGrade {
  const ri =
    rTick === undefined
      ? records.findIndex((r) => paceOf(r, ids.outletId) === fastTicks)
      : records.findIndex((r) => r.t >= rTick);
  return gradeAt(records, ids, ri);
}

/** One plain sentence per failure of the front-first order; EMPTY when the order holds. */
export function frontFirstViolations(grade: ReleaseGrade): string[] {
  if (grade.R === null) return ['no R: no record carries the fast outlet pace'];
  const out: string[] = [];
  if (grade.unobservable !== null) out.push(`unobservable at R ${grade.R}: ${grade.unobservable}`);
  if (grade.frontFree === null) {
    out.push(
      `no FRONT FREE: after R ${grade.R} no record shows the Tee off BACKED_UP with the inlet's slot 0 empty`,
    );
  }
  if (grade.junction === null) {
    out.push(`the release never reached the upstream belt within the recording (R ${grade.R})`);
  } else if (grade.frontFree !== null && grade.junction <= grade.frontFree) {
    out.push(
      `the release reached the upstream belt (tick ${grade.junction}) at or before FRONT FREE (tick ${grade.frontFree})`,
    );
  }
  if (grade.frontFree !== null && grade.witness === 0) {
    out.push(`no witness: no record lies between FRONT FREE (tick ${grade.frontFree}) and the junction`);
  }
  return out;
}

/** The one log line, shared by the spec and the unit cases. */
export function releaseOrderLine(grade: ReleaseGrade): string {
  const v = (x: number | null): string => (x === null ? 'none' : String(x));
  const base =
    `RELEASE_ORDER R=${v(grade.R)} teeOff=${v(grade.teeOff)} frontFree=${v(grade.frontFree)} ` +
    `junction=${v(grade.junction)} missed=${grade.missed} witness=${grade.witness} wrongway=${grade.wrongway}`;
  const drip =
    grade.dripRefill === null ? '' : ` dripRefill=${grade.dripRefill.refill} hidden=${grade.dripRefill.hidden}`;
  return grade.unobservable === null ? base + drip : `${base}${drip} unobservable="${grade.unobservable}"`;
}

/**
 * Grade every record of a STEADY-JAM recording, one that holds no release, as a pseudo-R: every
 * record with a record before it (signal (a) needs one) and at least 40 records after it.
 * `frontFirst` counts the gradings with NO violation. A grader that can tell a release from a
 * drip reports `frontFirst=0` here.
 */
export function pseudoRLine(jamRecords: readonly JamRecord[], ids: JamIds): string {
  let graded = 0;
  let frontFirst = 0;
  for (let i = 1; i + 40 <= jamRecords.length - 1; i++) {
    graded++;
    if (frontFirstViolations(gradeAt(jamRecords, ids, i)).length === 0) frontFirst++;
  }
  return `PSEUDO_R graded=${graded} frontFirst=${frontFirst}`;
}

/** The pack order, graded from the slow-pace record. */
export interface PackGrade {
  /** The first recorded tick at which P reached each boundary, or null. */
  firsts: (number | null)[];
  violations: string[];
}

/**
 * THE LINE PACKS BACKWARDS, graded on `records` that start at the first record carrying the
 * outlet's slow pace. P = prefix(inlet) + (prefix(inlet) is 12 ? prefix(upstream) : 0); the first
 * ticks at which P reaches 4, 8, 12, 16, 20 and 24 must be strictly increasing.
 *
 * THE TIE RULE. A boundary already met on the FIRST graded record is a violation: every boundary
 * met there shares that one tick, so "strictly increasing" cannot be read from it. This is what
 * stops an inherited pack (leg 2's run arriving packed) passing as a pack that formed.
 */
export function packsBackwards(records: readonly JamRecord[], ids: JamIds): PackGrade {
  const P = (r: JamRecord): number => {
    const d = prefix(slotsOf(r, ids.inletId) ?? []);
    return d + (d === BELT_SLOTS ? prefix(slotsOf(r, ids.upstreamId) ?? []) : 0);
  };
  const firsts = PACK_BOUNDARIES.map((k) => records.find((r) => P(r) >= k)?.t ?? null);
  const violations: string[] = [];
  if (records.length === 0) return { firsts, violations: ['no records from the slow-pace record on'] };
  const p0 = P(records[0]);
  const met = PACK_BOUNDARIES.filter((k) => p0 >= k);
  if (met.length > 0) {
    violations.push(
      `boundaries ${met.join(', ')} already met at the first graded record (tick ${records[0].t}, P ${p0}): an inherited pack, a tie`,
    );
  }
  PACK_BOUNDARIES.forEach((k, i) => {
    const t = firsts[i];
    if (t === null) {
      violations.push(`P never reached ${k}`);
      return;
    }
    const prev = i > 0 ? firsts[i - 1] : null;
    if (i > 0 && prev !== null && t <= prev) {
      violations.push(
        `boundary ${k} was first reached on the same tick as boundary ${PACK_BOUNDARIES[i - 1]} (tick ${t}): a tie`,
      );
    }
  });
  return { firsts, violations };
}

/** The jam's two fractions over `records`. */
export function jamFractions(
  records: readonly JamRecord[],
  ids: JamIds,
): { records: number; backedUp: number; headHeld: number } {
  return {
    records: records.length,
    backedUp: fraction(records, (r) => stateOf(r, ids.teeId) === STATE_BACKED_UP),
    headHeld: fraction(records, (r) => (slotsOf(r, ids.inletId) ?? []).includes(0)),
  };
}

/** The flowing baseline's readings over `records`: the inlet's head and both belts' counts. */
export function flowingBaseline(
  records: readonly JamRecord[],
  ids: JamIds,
): {
  records: number;
  headOccupied: number;
  inletMean: number;
  inletMax: number;
  upstreamMean: number;
  upstreamMax: number;
} {
  const counts = (id: number): number[] => records.map((r) => (slotsOf(r, id) ?? []).length);
  const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
  const inlet = counts(ids.inletId);
  const up = counts(ids.upstreamId);
  return {
    records: records.length,
    headOccupied: fraction(records, (r) => (slotsOf(r, ids.inletId) ?? []).includes(0)),
    inletMean: mean(inlet),
    inletMax: inlet.length === 0 ? 0 : Math.max(...inlet),
    upstreamMean: mean(up),
    upstreamMax: up.length === 0 ? 0 : Math.max(...up),
  };
}

/**
 * Each run tile's THINNING TICK: the first recorded tick from which that tile holds at most 2 of
 * its 4 slots to the end of the recording, or null when it holds more on the last record. Six
 * entries, from the run's tail to its head: the upstream's tail, middle and head tiles, then the
 * inlet's tail, middle and head tiles (cells (5..10,12) in leg 3). A 12-slot belt's tile k from
 * its tail holds slots `12 - 4(k+1)` to `12 - 4k - 1`.
 */
export function thinningTicks(records: readonly JamRecord[], ids: JamIds): (number | null)[] {
  const out: (number | null)[] = [];
  for (const id of [ids.upstreamId, ids.inletId]) {
    for (let k = 0; k < 3; k++) {
      const lo = BELT_SLOTS - SLOTS_PER_TILE * (k + 1);
      const hi = lo + SLOTS_PER_TILE - 1;
      const n = (r: JamRecord): number => (slotsOf(r, id) ?? []).filter((s) => s >= lo && s <= hi).length;
      let i = records.length;
      while (i > 0 && n(records[i - 1]) <= 2) i--;
      out.push(i === records.length ? null : records[i].t);
    }
  }
  return out;
}

/**
 * The RELEASE SUSTAINED window: the `length` records from the first at or after `fromTick`, with
 * the fraction on which the Tee is not `BACKED_UP` and the fraction on which the inlet's slot 0 is
 * empty. `count` below `length` means the recording does not reach that far yet.
 */
export function releaseSustained(
  records: readonly JamRecord[],
  ids: JamIds,
  fromTick: number,
  length: number,
): { from: number | null; to: number | null; count: number; teeOff: number; headEmpty: number } {
  const win = records.filter((r) => r.t >= fromTick).slice(0, length);
  return {
    from: win[0]?.t ?? null,
    to: win[win.length - 1]?.t ?? null,
    count: win.length,
    teeOff: fraction(win, (r) => stateOf(r, ids.teeId) !== STATE_BACKED_UP),
    headEmpty: fraction(win, (r) => !(slotsOf(r, ids.inletId) ?? []).includes(0)),
  };
}

/** The outlet's three steady-state readings over `records`. */
export function outletSteadyReading(
  records: readonly JamRecord[],
  outletId: number,
): { slot0: number; grow: number; changes: number } {
  const slots = records.map((r) => slotsOf(r, outletId) ?? []);
  let changes = 0;
  for (let i = 1; i < slots.length; i++) if (!sameSlots(slots[i], slots[i - 1])) changes++;
  return {
    slot0: fraction(records, (r) => (slotsOf(r, outletId) ?? []).includes(0)),
    grow: slots.length === 0 ? 0 : slots[slots.length - 1].length - slots[0].length,
    changes,
  };
}

/**
 * THE CLOSE AT STEADY STATE, graded at the Sink end. A Sink takes each item as it arrives, so the
 * outlet's slot 0 is occupied on at most half the records; its count on the last record is at
 * most 2 above the first (no unbounded growth); and its occupancy changes on at least 5 records
 * (items move). A Sink that stopped taking holds slot 0 and lets the count climb. EMPTY when all
 * three hold.
 */
export function outletSteadyViolations(records: readonly JamRecord[], outletId: number): string[] {
  if (records.length === 0) return ['no records to grade the outlet on'];
  const { slot0, grow, changes } = outletSteadyReading(records, outletId);
  const out: string[] = [];
  if (slot0 > 0.5) {
    out.push(
      `the outlet's slot 0 (the Sink end) was occupied on ${slot0.toFixed(2)} of the records, above half: the Sink is not taking`,
    );
  }
  if (grow > 2) out.push(`the outlet's item count grew by ${grow} across the window, above 2`);
  if (changes < 5) out.push(`the outlet's occupancy changed on ${changes} records, fewer than 5: items are not moving`);
  return out;
}

// ===========================================================================
// THE GAUGE, GRADED BY THE TICK IT WAS DRAWN FROM (plan 77-07, phase 77 D-04)
// ===========================================================================
//
// The recorder reads the scene model and the Tee's gauge form (`loadGaugeFormOn`, read off the
// gauge Graphics) in the same sample. The model is updated as each packet lands (`App.tsx`
// `applyPacket`); the gauge is plotted only when the render loop calls `machines.draw(scene,
// frame)` (`frontend/src/render/loop.ts:284`), once per display frame. So a record at tick T
// usually carries the form drawn FROM tick T-1: measured on three runs, lag 1 on about four records
// in five and up to 4 (77-MUTATION-PROOF.md, "Plan 77-07 gauge lag measurement"). A grader that
// took the record's tick would put the merged bar drawn just before a release beside the release
// record and fail a correct build. Every function below reads a form only through its own
// `drawnAtTick`.

/**
 * The forms recorded for `id`, ONE per drawn tick (the latest record carrying it wins), in
 * ascending drawn tick. Records with no form for `id`, or a `null` one (not yet drawn), add
 * nothing.
 */
export function gaugeFormsByDrawnTick(records: readonly JamRecord[], id: number): GaugeForm[] {
  const byTick = new Map<number, GaugeForm>();
  for (const r of records) {
    const form = r.g?.find((f) => f[0] === id)?.[1];
    if (form != null) byTick.set(form.drawnAtTick, form);
  }
  return [...byTick.values()].sort((a, b) => a.drawnAtTick - b.drawnAtTick);
}

/** Of the forms drawn at a tick in `[fromTick, toTick]`, how many, how many merged, and the
 *  fraction (0 when none was drawn there). Each drawn tick counts once. */
export function mergedFraction(
  forms: readonly GaugeForm[],
  fromTick: number,
  toTick: number,
): { drawn: number; merged: number; fraction: number } {
  const inside = forms.filter((f) => f.drawnAtTick >= fromTick && f.drawnAtTick <= toTick);
  const merged = inside.filter((f) => f.merged).length;
  return { drawn: inside.length, merged, fraction: inside.length === 0 ? 0 : merged / inside.length };
}

/**
 * One plain sentence per merged bar drawn at or after `fromTick`, or one when no form was drawn
 * at or after it at all (an empty set must never pass). EMPTY when the bar is broken on every
 * frame drawn from `fromTick` on.
 */
export function gaugeReleaseViolations(forms: readonly GaugeForm[], fromTick: number): string[] {
  const after = forms.filter((f) => f.drawnAtTick >= fromTick);
  if (after.length === 0) return [`no frame drawn at or after tick ${fromTick}: nothing shows the bar broken`];
  return after
    .filter((f) => f.merged)
    .map((f) => `merged bar drawn at tick ${f.drawnAtTick}, at or after tick ${fromTick}`);
}

// ===========================================================================
// THE MERGED BAR AGAINST THE DRIPS (plan 84-18, push 5)
// ===========================================================================
//
// Decision D-12, 2026-10-18: "Check against drips". Run 4 (CI) read the bar on
// 15 of 18 drawn frames, 0.833 under the old fixed share `JAM_MERGED_MIN` (0.85), with the product
// unchanged. Measured on four local traces, two unthrottled and two at the GPU proxy (84-EVIDENCE.md,
// "Plan 84-18: push 5"): the bar is broken on EXACTLY the drip tick, the one tick the Tee reads off
// `BACKED_UP` as it emits into the outlet, and merged on every other tick; and the drips fall once
// per outlet advance, every `ticksPerSlot` ticks, all on ONE tick of that cycle (the outlet advances
// only on ticks that are a multiple of its pace, `belt.rs`). So how many drawn frames show the bar
// broken depends on how often a page's frames land on a drip tick, which is the frame rate, not the
// product: at about 10 ticks a frame a page can land on the drip every other drip.
//
// THE RULE. The drips are read off the records (every recorded tick with the Tee off `BACKED_UP`);
// they must share one tick of the outlet's pace cycle (its PHASE), and every tick on that phase is a
// drip tick whether or not a record shows it (the recorder misses ticks; a drip it missed is still a
// drip). Then: every drawn frame with the bar broken is on a drip tick; between every two drip ticks
// with frames drawn between them, at least one of those frames shows the merged bar; and at least
// one merged bar is drawn at all (an all-broken gauge never passes).

/** What `mergedBarAgainstDrips` reads off a steady jam. */
export interface DripBarGrade {
  /** The outlet's ticks per slot across the window, or null when it is not one value. */
  pace: number | null;
  /** The tick of the pace cycle every recorded drip falls on, or null when they do not share one. */
  phase: number | null;
  /** The recorded ticks with the Tee off `BACKED_UP`. */
  drips: number[];
  drawn: number;
  merged: number;
  /** Drawn frames on a drip tick showing the bar broken: allowed. */
  brokenOnDrips: number;
  violations: string[];
}

export function mergedBarAgainstDrips(
  records: readonly JamRecord[],
  forms: readonly GaugeForm[],
  ids: JamIds,
  fromTick: number,
  toTick: number,
): DripBarGrade {
  const window = records.filter((r) => r.t >= fromTick && r.t <= toTick);
  const inside = forms.filter((f) => f.drawnAtTick >= fromTick && f.drawnAtTick <= toTick);
  const merged = inside.filter((f) => f.merged).length;
  const violations: string[] = [];
  const paces = new Set(
    window.map((r) => r.belts.find((b) => b[0] === ids.outletId)?.[1]).filter((v): v is number => v !== undefined),
  );
  const pace = paces.size === 1 ? [...paces][0] : null;
  if (pace === null) violations.push(`the outlet's pace is not one value across the window (${[...paces].join(', ') || 'none'})`);
  const drips = window.filter((r) => stateOf(r, ids.teeId) !== STATE_BACKED_UP).map((r) => r.t);
  if (drips.length === 0) violations.push('no drip recorded in the steady jam: nothing to grade the broken bar against');
  let phase: number | null = null;
  if (pace !== null && drips.length > 0) {
    const phases = new Set(drips.map((t) => ((t % pace) + pace) % pace));
    if (phases.size === 1) phase = [...phases][0];
    else violations.push(`drips at more than one tick of the outlet pace ${pace}: ${drips.join(',')}`);
  }
  const onDrip = (t: number): boolean => phase !== null && pace !== null && ((t % pace) + pace) % pace === phase;
  let brokenOnDrips = 0;
  if (phase !== null && pace !== null) {
    for (const f of inside) {
      if (f.merged) continue;
      if (onDrip(f.drawnAtTick)) brokenOnDrips++;
      else violations.push(`bar broken at tick ${f.drawnAtTick}, between drips (they fall on ticks ${phase} mod ${pace})`);
    }
    // Between every two drip ticks, the frames drawn there: at least one merged.
    const first = fromTick - (((fromTick - phase) % pace) + pace) % pace;
    for (let a = first; a <= toTick; a += pace) {
      const between = inside.filter((f) => f.drawnAtTick > a && f.drawnAtTick < a + pace);
      if (between.length > 0 && !between.some((f) => f.merged)) {
        violations.push(`no merged bar on the ${between.length} frame(s) drawn between the drips at ${a} and ${a + pace}`);
      }
    }
  }
  if (merged === 0) violations.push(`no merged bar drawn on any of the ${inside.length} frames of the steady jam`);
  return { pace, phase, drips, drawn: inside.length, merged, brokenOnDrips, violations };
}
