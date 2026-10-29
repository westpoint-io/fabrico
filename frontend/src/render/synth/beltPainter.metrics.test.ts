// The SHIPPED belt measurement suite (Phase 54) - the locked-look assertions that
// outlive the deleted Phase 53 exploration surface.
//
// WHY THIS FILE EXISTS. The Phase 53 exploration surface proved the locked
// Direction B numbers from its own bakes and was deleted whole in 54-03. Every
// objective speed/spacing/corner claim the lock makes about the SHIPPED belt was
// re-stated here against the shipped painter record and the shipped bake bytes, so the
// evidence survived that deletion by construction (54-CONTEXT "Objective
// speed/spacing/corner assertions OUTLIVE the kit").
//
// WHAT PLAN 61-07 REMOVED FROM THIS FILE, AND WHERE EACH CLAIM WENT. Five describe
// blocks measured RASTER bake BYTES: the full-flow-axis centreline dash, the 1px
// INVERTED lane and rail, the corner pinch + joint guard + inner-rail arc, the
// 9-distinct-in-15-slots inventory, and the two LOD tick bakes. Plan 61-07 deleted the
// four bakes, so those blocks have no bytes to read and RETIRE WITH THEIR SUBJECT -
// they are not weakened, relaxed or commented out. Each measured a belt that has not
// been drawn since plan 61-03; the belt Fabrico actually draws is gated by
// `beltGeometry.test.ts` (lane, rails, dash, zero pinch, the device-quantum rail band),
// `beltGeometry.digest.test.ts` (all 39 tread slots + 50 rail probes) and
// `e2e/belt-rail-continuity.spec.ts` (rails through the 0.75-1.00 scale band).
//
// WHAT SURVIVES HERE IS THE HALF THAT WAS NEVER ABOUT BYTES: the split-knob march
// metrics, the cache ceilings, the context-key shapes and the nine-family vertex
// budget - all one-line derivations off the painter's own (pitch, phases, quantum)
// record and off measured `GraphicsContext` geometry.
//
// The dash-geometry literals below are TRANSCRIBED from 53-BELT-LOCK.md deliberately,
// not imported from the source under test: the whole point is that a silent mistype in
// the shipped constants fails HERE (threat T-54-01).

import { describe, expect, it } from 'vitest';
import { SHIPPED_PAINTER, beltPainterForBuckets } from './beltPainter.ts';
import { beltContextKey } from './beltContextCache.ts';
import {
  BELT_MARCH_BUCKET_COUNTS,
  MARCH_NYQUIST_CEILING_PX_PER_TICK,
  marchPxPerTick,
} from './beltGeometry.ts';
import { BELT_DASH_PERIOD } from '../../../shared/geometry.ts';
import { measureContext } from '../svgAssets.ts';
import { LOCKED_SKIN } from './skins/locked.ts';
import { SIM_TICKS_PER_FRAME } from '../interp.ts';
import { DEFAULT_NATIVE_CELL } from './generators.ts';

const SKIN = LOCKED_SKIN;
const N = DEFAULT_NATIVE_CELL; // 32 - the native authoring cell

// Locked dash geometry, transcribed from 53-BELT-LOCK.md axis 1 (never re-derived).
const DASH = 10;
const GAP = 6;
const DASH_REPEAT = DASH + GAP; // 16
const LOCKED_STEP = 8; // the RETIRED welded model's step: pitch 32 / K 4

describe('the march metrics, RE-DERIVED against the split-knob model (plan 61-04)', () => {
  // The advance per march step, and the number of steps per second. Under the welded
  // model these were `pitch / K` = 8px, ten times a second; under the split model they
  // are `period / K` = 1.333333px, sixty times a second. THE PRODUCT IS UNCHANGED and
  // that is what every case below is organised around.
  const step = SHIPPED_PAINTER.pitch / SHIPPED_PAINTER.phases;
  const alias = (step * (62.5 / SHIPPED_PAINTER.quantum)) / 60 / (SHIPPED_PAINTER.pitch / 2);
  const cacheBound = 3 * SHIPPED_PAINTER.phases + 3;

  // THE SHIPPED SLOT PITCH, HAND-TYPED. 32px cell / 4 slots per tile = 8px, both halves
  // pinned in Rust by `belt_slots.rs::slots_per_tile_divides_the_render_tile`. Typed here
  // rather than imported, on this file's own transcription discipline (threat T-54-01):
  // a silent mistype in the shipped constants must fail HERE.
  const SLOT_PITCH_PX = 8;

  /**
   * **THE FRONTEND'S ONLY MACHINE GATE ON D-05, and its previous form was FALSE.**
   *
   * This block used to assert that the tread marched at ONE EIGHTH of item speed. Two
   * things were wrong with that. The percentage itself was computed with the retired
   * `SLOTS_PER_TILE = 3` and the truth at HEAD was 16.67%, which the commit immediately
   * before this one corrects on its own so the defect is legible. And the RATIO ITSELF
   * is now superseded: `62-CONTEXT.md` D-05 sets it to exactly 100%. The painted surface
   * carries at the speed of its cargo; a tread crawling at a sixth of the items riding
   * it was the defect, not the specification.
   *
   * ASSERTED AS AN EQUALITY BETWEEN TWO px-PER-TICK FIGURES, not as a percentage
   * literal, and both sides come from the SAME wire-derived inputs: the belt's slot pitch
   * and its advance interval. A percentage would have to be a number typed here, and a
   * number typed here is what went stale for two phases.
   *
   * IT SUPERSEDES A SIGNED ART AXIS (D-07). `61-BELT-LOCK-SUPERSESSION.md`'s 80 px/sec
   * march-rate axis is retired by name; the dash PERIOD and the bucket architecture are
   * NOT, and both are still gated by the cases below.
   */
  it('paints the tread at EXACTLY the speed of its cargo - the D-05 identity', () => {
    // The item's px-per-tick: one slot pitch every `ticks_per_slot` ticks. The tread's
    // px-per-tick: whatever the render path derives for that same belt. D-05 is the
    // claim that these are one number, and the whole of this case is that claim.
    const itemPxPerTick = (interval: number): number => SLOT_PITCH_PX / interval;
    for (const interval of [1, 2, 3, 4, 6, 12]) {
      expect(marchPxPerTick(SLOT_PITCH_PX, interval), `interval ${interval}`).toBe(
        itemPxPerTick(interval),
      );
    }
    // ... and the ratio, stated once in the units the retired assertion used, so the
    // supersession reads as a MOVED NUMBER rather than as a deleted one: one eighth was
    // the claim, 16.67% was the truth at HEAD, 100% is the contract from this phase on.
    expect((100 * marchPxPerTick(SLOT_PITCH_PX, 4)) / itemPxPerTick(4)).toBe(100);

    // THE ONE THING THAT COULD BREAK THE IDENTITY, named so a future reader meets it as
    // a constraint rather than as a mystery: the render path CLAMPS the tread at the
    // aliasing ceiling (half the dash period per tick), so the identity holds only while
    // the slot pitch is at or under that ceiling. At the shipped 8px pitch and a 16px
    // period they are exactly equal, which is why an interval of 1 sits ON the wall.
    // A future slot pitch above 8px would clamp the tread BELOW its cargo and redden
    // this case, which is correct: Nyquist wins, and a human decides what to do.
    expect(SLOT_PITCH_PX).toBe(BELT_DASH_PERIOD / 2);
    expect(marchPxPerTick(SLOT_PITCH_PX, 1)).toBe(SLOT_PITCH_PX);
    expect(marchPxPerTick(2 * SLOT_PITCH_PX, 1)).toBeLessThan(2 * itemPxPerTick(1));

    // The PAINTER's step is untouched by any of this, and saying so is what keeps the
    // supersession honest about its own radius. `step` is `period / K` = 1.333333px, a
    // sixth of the locked 8px delivered six times as often; `LOCKED_STEP` is the
    // transcribed 53-BELT-LOCK figure, kept and re-pointed rather than deleted. What
    // moved is the ADVANCE, which is a per-belt derivation and is not in the painter
    // record at all.
    expect(step).toBeCloseTo(LOCKED_STEP / 6, 12);
    expect(step * (SIM_TICKS_PER_FRAME / SHIPPED_PAINTER.quantum)).toBeCloseTo(LOCKED_STEP, 12);
  });

  it('states the aliasing margin PER SIM TICK: ON the wall at identity, HALF of it as shipped', () => {
    // READ THE MOVE BEFORE READING THE NUMBER, TWICE OVER.
    //
    // (1) This margin is the wagon-wheel ratio: advance over HALF THE PATTERN PERIOD. It
    //     read 0.087 until plan 61-04 because `pitch` was the MARCH pitch (32) while the
    //     pattern's own repeat has always been 10 + 6 = 16, so the correct denominator
    //     has always been 8. The shipped belt was ALWAYS at ~0.17; the old figure
    //     understated it by exactly 2x.
    // (2) **IT IS NOW STATED PER SIM TICK RATHER THAN PER DRAWN FRAME, and that is the
    //     unit change plan 62-04 makes throughout the render path (D-05).** The
    //     per-frame form needed a host-ticks-to-display-frames reconciliation (62.5 / 60)
    //     to be honest, and that reconciliation was the entire job of the three
    //     ticks-per-second constants this plan DELETED. Per sim tick the margin is
    //     `advance / (period / 2)` with no conversion in it, and the two forms differ by
    //     under 4% - so the claim does not move, only the arithmetic that supports it.
    expect(SHIPPED_PAINTER.pitch).toBe(DASH_REPEAT); // the corrected denominator's source
    const marginPerTick = (pxPerTick: number): number => pxPerTick / (DASH_REPEAT / 2);
    // The painter's own step, i.e. the tread of a belt slow enough to walk one bucket a
    // tick. This is the margin the retired art-directed rate produced.
    expect(marginPerTick(step)).toBeCloseTo(0.1667, 4);
    expect(marginPerTick(step)).toBeLessThan(0.55); // the wagon-wheel ceiling, far away
    // The old per-frame figure, kept beside it so the re-expression is legible rather
    // than reconstructed: 0.1736 was the same margin with the host-rate correction in it.
    expect(alias).toBeCloseTo(0.1736, 4);
    expect(alias / marginPerTick(step)).toBeCloseTo(62.5 / 60, 4);
    // THE CEILING ITSELF, in px per SIM TICK so no ticks-per-second figure is needed: a
    // dash pattern cannot convey motion faster than half its period per drawn step.
    expect(MARCH_NYQUIST_CEILING_PX_PER_TICK).toBe(DASH_REPEAT / 2);
    // **THE TREAD SAT EXACTLY ON IT AT THE IDENTITY INTERVAL.** D-05 makes the surface
    // carry at its cargo's speed, and an item crosses one 8px slot per tick while
    // `ticks_per_slot` is 1 - which is exactly half the period, margin 0.5 of a period
    // and therefore 1.0 in these units, the maximally direction-ambiguous displacement.
    // The retired prose drew the right conclusion from the same arithmetic ("the tread
    // CANNOT honestly match item speed at the locked period") and answered it by keeping
    // the tread decorative; this phase answers it by SLOWING THE BELT instead.
    //
    // In THESE units the wall is 1.0 (advance == half a period), which is what makes the
    // `< 0.55` bound above a comfort margin rather than the ceiling itself.
    expect(marginPerTick(marchPxPerTick(SLOT_PITCH_PX, 1))).toBe(1);
    expect(marginPerTick(MARCH_NYQUIST_CEILING_PX_PER_TICK)).toBe(1);

    // **AND THE SHIPPED TREAD IS OFF THE WALL, WHICH IS THE WHOLE PHASE.** Plan 62-09
    // landed the maintainers' judged interval of 2 (`62-SITTING-VERDICT.md`, its only admissible
    // source), so the shipped advance is 4px per sim tick - HALF the 8px ceiling, a
    // wagon-wheel margin of 0.5 against a wall of 1.0. D-06's hard floor said "at most
    // half today's pace"; 2 is the fastest value that clears it, so 0.5 is the LEAST
    // margin this phase could legally ship and the figure is worth having pinned rather
    // than recomputed.
    //
    // BOTH NUMBERS ARE HAND-TYPED (D-22). `SHIPPED_TICKS_PER_SLOT` mirrors a Rust
    // constant this file cannot import and `SHIPPED_PX_PER_TICK` is its consequence
    // typed out, so `marchPxPerTick` has to agree with THEM. Deriving either from the
    // other, or from the sim, is the exact failure `62-CORPUS-REVIEW.md` FINDING 9-F
    // records: this suite's identity assertions were placed to redden the day the real
    // interval landed, that day came, and they did not move. The cross-language check
    // that now notices a moved interval lives in `belts.test.ts`, once, so this file
    // states the METRIC and that one states the LINK.
    const SHIPPED_TICKS_PER_SLOT = 2;
    const SHIPPED_PX_PER_TICK = 4;
    expect(marchPxPerTick(SLOT_PITCH_PX, SHIPPED_TICKS_PER_SLOT)).toBe(SHIPPED_PX_PER_TICK);
    expect(SHIPPED_PX_PER_TICK).toBe(MARCH_NYQUIST_CEILING_PX_PER_TICK / 2);
    expect(marginPerTick(SHIPPED_PX_PER_TICK)).toBe(0.5);
    // ...and it now clears the comfort bound the painter's own retired art rate was
    // measured against, rather than merely clearing the wall.
    expect(marginPerTick(SHIPPED_PX_PER_TICK)).toBeLessThan(1);
  });

  // ---------------------------------------------------------------------------
  // THE CACHE CEILING, RE-DERIVED IN ONE PLACE (plan 61-09)
  // ---------------------------------------------------------------------------
  //
  //   156  `61-UI-SPEC` A8, PROVISIONAL. Owned by the UI spec. It keyed a `zoomBucket`
  //        term (|Z| <= 4) into the cache against Pixi's `buildAdaptiveBezier`
  //        stale-tessellation hazard: 4 x (3K + 3).
  //    39  PLAN 61-03 / `61-RESEARCH.md` FINDING 1, a TIGHTENING. The corner emitters
  //        hand out self-sampled point lists and never reach a Pixi curve command, so
  //        one fixed tessellation serves the whole zoom range and the zoom term is gone.
  //        Owned by plan 61-04, which put the literal in the tree.
  //  39+5  PLAN 61-09. The rails became their own device-quantum-aware family, so the
  //        LAYER now holds 39 TREAD contexts plus 5 RAIL contexts = **44**.
  //
  // **THE LAYER TOTAL IS NOT TIGHTENED BY THIS PLAN AND MUST NOT BE REPORTED AS IF IT
  // WERE.** The ROADMAP's "re-derive, never loosen" clause governs the phase-bucket
  // TREAD cache, and on that term nothing moved: still exactly `3K + 3`, still an
  // equality, still with no zoom segment. The total rises 39 -> 44 because a belt asset
  // family EXISTS that did not exist before. The new term is named rather than absorbed.
  const RAIL_FAMILIES = 5; // 1 straight + 2 corner chiralities + 2 corner LOD chiralities
  const SUPERSEDED_CEILING_WITH_ZOOM_BUCKETS = 156;

  it('bounds the belt geometry cache at 3K + 3 = 39 slots - TIGHTENED from 156', () => {
    // **39, WRITTEN AS A BARE LITERAL, AND 156 NAMED BESIDE IT.** The derivation
    // (`3 * phases + 3`) is the comment that explains the literal, never the expression
    // the assertion evaluates: a derivation-only assertion agrees with itself at ANY
    // bucket count, which is the `machineChassis.ts:44-57` counter-rule this repo
    // already applies to the straight suite. Moving `BELT_MARCH_BUCKETS` without
    // touching this line reddens HERE, which is the whole point of the literal.
    //
    // THE TIGHTENING, so it is readable in the diff rather than reconstructed. The
    // ROADMAP attached a "re-derive, never loosen" clause to this exact invariant.
    // `61-UI-SPEC` A8 provisionally keyed a `zoomBucket` term (|Z| <= 4) into the cache
    // against Pixi's `buildAdaptiveBezier` stale-tessellation hazard and set the ceiling
    // at 4 * (3K + 3) = 156. Plan 61-03 retired that hazard BY CONSTRUCTION - the corner
    // emitters hand out self-sampled point lists and never reach a Pixi curve command -
    // so one fixed tessellation serves the whole zoom range, there is no zoom-bucket
    // term, and the ceiling is the slot count itself. 39, not 156.
    expect(cacheBound).toBe(39);
    expect(cacheBound * 4).toBe(SUPERSEDED_CEILING_WITH_ZOOM_BUCKETS);
    expect(cacheBound).toBeLessThan(SUPERSEDED_CEILING_WITH_ZOOM_BUCKETS);
    // The families the 39 is made of: K straights + 2K corners + 1 straight tick + 2
    // corner ticks. Spelled out because "3K + 3" is opaque about which 3.
    expect(SHIPPED_PAINTER.phases + 2 * SHIPPED_PAINTER.phases + 1 + 2).toBe(39);
    // **PLAN 61-09 DID NOT MOVE THIS NUMBER**, and that is the claim the whole rail
    // split rests on: the rails left these contexts precisely so the TREAD cache would
    // stay scale-free, three-segment-keyed and equal to `3K + 3`. If a future edit put a
    // quantum back into a tread key, this equality would be the first thing to go.
    expect(cacheBound).toBe(3 * SHIPPED_PAINTER.phases + 3);
  });

  it('adds a RAIL ceiling of exactly 5, making the LAYER total 44 - NOT a tightening', () => {
    // **44, WRITTEN AS A BARE LITERAL, WITH 39 AND 156 BOTH NAMED BESIDE IT**, so the
    // whole audit trail reads in one place rather than being reconstructed from three
    // plans' derivations. 5 = 1 straight rail + 2 corner chiralities at the full sample
    // count + the same 2 at the low-zoom count.
    const layerTotal = cacheBound + RAIL_FAMILIES;
    expect(RAIL_FAMILIES).toBe(5);
    expect(layerTotal).toBe(44);
    // THE HONEST DIRECTION OF TRAVEL. The ROADMAP's "re-derive, never loosen" clause is
    // about the phase-bucket TREAD cache and is satisfied on that term - 39 is unmoved
    // above. The LAYER TOTAL rises, because a belt asset family exists that did not
    // exist before, and asserting the RISE is what stops it being reported as a
    // tightening by a later summariser who only sees one number.
    expect(layerTotal).toBeGreaterThan(cacheBound);
    expect(layerTotal - cacheBound).toBe(RAIL_FAMILIES);
    // ... and it is still far under the ceiling 156 the UI spec provisionally set.
    expect(layerTotal).toBeLessThan(SUPERSEDED_CEILING_WITH_ZOOM_BUCKETS);
    expect(SUPERSEDED_CEILING_WITH_ZOOM_BUCKETS - layerTotal).toBe(112);
  });

  it('holds all three equalities at EVERY legal bucket count, not only the default', () => {
    // The rail ceiling is INDEPENDENT of K - the rails are phase-independent, which is
    // exactly why they can be one asset per family rather than K of them. Asserting it
    // across the three counts the settings panel offers is what makes that a gated
    // property rather than a coincidence at 12.
    for (const k of BELT_MARCH_BUCKET_COUNTS) {
      const painter = beltPainterForBuckets(k);
      expect(3 * painter.phases + 3, `tread ceiling at K = ${k}`).toBe(3 * k + 3);
      expect(RAIL_FAMILIES, `rail ceiling at K = ${k}`).toBe(5);
      expect(3 * painter.phases + 3 + RAIL_FAMILIES, `layer total at K = ${k}`).toBe(3 * k + 8);
    }
    // The three concrete totals, as literals, so a K move is a visible edit here.
    expect([12, 16, 24].map((k) => 3 * k + 8)).toEqual([44, 56, 80]);
    expect(BELT_MARCH_BUCKET_COUNTS).toEqual([12, 16, 24]);
  });

  it('keys the RAIL families by three segments with no quantum term', () => {
    // **THE QUANTUM IS A LIFETIME TERM AND NEVER A KEY TERM.** A future edit that keyed
    // the rail cache by scale would make the key space CONTINUOUS and multiply the cache
    // without bound under a zoom gesture - silently, because nothing else in the suite
    // counts rail entries. It reddens here instead.
    for (const [kind, chirality] of [
      ['belt-rail', 'none'],
      ['belt-corner-rail', 'cw'],
      ['belt-corner-rail', 'ccw'],
      ['belt-corner-rail-tick', 'cw'],
      ['belt-corner-rail-tick', 'ccw'],
    ] as const) {
      const key = beltContextKey(kind, chirality, 0);
      expect(key.split('|'), `${kind}|${chirality}`).toHaveLength(3);
      expect(key).not.toMatch(/q[=0-9.]/);
    }
    // The five names above ARE the five families, so the ceiling and the key list
    // cannot drift apart.
    expect(RAIL_FAMILIES).toBe(5);
  });

  it('re-measures the vertex budget of all NINE context families after the split', () => {
    // THE SPLIT MOVED VERTICES BETWEEN FAMILIES AND THE NUMBERS ARE RE-TAKEN THROUGH THE
    // PROJECT'S OWN MEASUREMENT PATH, not estimated. The corner TREAD falls well below
    // the 264-284 its docblock recorded, because the rail arcs were the bulk of it.
    //
    // **THE LOW-ZOOM SAMPLE COUNT IS NOT REOPENED ON THE STRENGTH OF THE NEW HEADROOM.**
    // `LOD_ARC_SAMPLES` = 12 was chosen on CHORD ERROR at the LOD cut as well as on the
    // budget (0.027 device px at the 0.75 device scale the cue is capped at), and
    // raising it would move a look this phase has already committed. The headroom is
    // recorded; it is not spent.
    const measured: Array<[string, number]> = [];
    for (let k = 0; k < SHIPPED_PAINTER.phases; k++) {
      measured.push([`tread straight|${k}`, measureContext(SHIPPED_PAINTER.straight(SKIN, k, N)).vertexCount]);
      for (const ch of ['cw', 'ccw'] as const) {
        measured.push([
          `tread corner|${ch}|${k}`,
          measureContext(SHIPPED_PAINTER.corner(SKIN, k, ch, N)).vertexCount,
        ]);
      }
    }
    measured.push(['tread straight-tick', measureContext(SHIPPED_PAINTER.straightTick(SKIN, N)).vertexCount]);
    for (const ch of ['cw', 'ccw'] as const) {
      measured.push([
        `tread corner-tick|${ch}`,
        measureContext(SHIPPED_PAINTER.cornerTick(SKIN, ch, N)).vertexCount,
      ]);
    }
    // The five rail families, at the quantum with the MOST geometry in it. The rail
    // vertex count is sample-count-driven and quantum-independent, but measuring at a
    // fractional quantum keeps the case honest about what actually ships.
    for (const q of [0.75, 1, 1.77]) {
      measured.push([`rail straight|q${q}`, measureContext(SHIPPED_PAINTER.rails(SKIN, q)).vertexCount]);
      for (const ch of ['cw', 'ccw'] as const) {
        measured.push([
          `rail corner|${ch}|q${q}`,
          measureContext(SHIPPED_PAINTER.cornerRails(SKIN, q, ch)).vertexCount,
        ]);
        measured.push([
          `rail corner-tick|${ch}|q${q}`,
          measureContext(SHIPPED_PAINTER.cornerRailTick(SKIN, q, ch)).vertexCount,
        ]);
      }
    }
    for (const [name, count] of measured) {
      // The silent-empty backstop first: a procedural builder fails by producing
      // NOTHING, which sails under every ceiling by being under all of them.
      expect(count, `${name} tessellated to ZERO geometry`).toBeGreaterThan(0);
      expect(count, `${name} measured ${count} vertices`).toBeLessThan(400);
    }
    // THE HEADROOM THE SPLIT BOUGHT, as a number rather than as a claim. Every family -
    // tread AND rail - is now inside the 300 WARN band, which was not true of the corner
    // tread before (264-284 against a 300 warn) and is the measured benefit of moving
    // the rail arcs into a separately budgeted asset.
    const worst = Math.max(...measured.map(([, c]) => c));
    expect(worst, `the heaviest belt family measured ${worst} vertices`).toBeLessThan(300);
  });

  it('has come OFF the 10fps clock, deliberately: quantum is 1 sim tick, not 6', () => {
    // THE CONTROL PROPERTY INVERTED, AND THE INVERSION IS THE DECISION. This case used
    // to assert `quantum === SIM_TICKS_PER_FRAME` - "the march clock IS the MOTION-01
    // animation clock, and the two must not drift apart". `61-CONTEXT.md` section B
    // (maintainer decision, 2026-08-10) overturns that: belts march at the sim tick
    // rate while machine sprite animation stays deliberately chunky at 10fps. Asserting
    // the INEQUALITY keeps the relationship gated - a silent re-coupling reddens here
    // rather than quietly restoring the strobe.
    expect(SHIPPED_PAINTER.quantum).toBe(1);
    expect(SHIPPED_PAINTER.quantum).not.toBe(SIM_TICKS_PER_FRAME);
    expect(SIM_TICKS_PER_FRAME).toBe(6);
    // Determinism is NOT weakened by the decoupling, and this is the readable form of
    // that claim: the march quantum is a whole number of SIM TICKS, so the phase stays
    // a pure function of the designated render clock exactly as it was at 6.
    expect(Number.isInteger(SHIPPED_PAINTER.quantum)).toBe(true);
  });
});

