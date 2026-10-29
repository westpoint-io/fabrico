// The BeltPainter march-model probe (born Phase 53 Wave 1; re-derived by plan 61-04).
//
// GPU-free and pure arithmetic in its first half: it drives no bake and reads no pixel.
//
// WHAT THIS FILE USED TO PIN, AND WHY THAT CLAIM IS GONE RATHER THAN WEAKENED. Until
// plan 61-04 its whole job was a byte-identity proof: that the painter's march form
// `floor(clock / T) mod K` selected the SAME phase as the shipped composition
// `marchPhaseOf(quantizedFrame(clock))`, resting on 4 dividing 24. That equality was
// what made `SHIPPED_PAINTER` safe to install as the layer default without moving a
// pixel. **It is FALSE from 61-04 on, by design**: the belt no longer derives its phase
// from the MOTION-01 frame index at all (`61-CONTEXT.md` section B - belts march at the
// sim tick rate, machines stay chunky at 10fps), so there is no composition left for it
// to equal and `marchPhaseOf` no longer exists. Adjusting the old case to the new
// arithmetic would have produced an assertion that agreed with itself.
//
// WHAT REPLACES IT IS THE CLAIM THAT ACTUALLY MATTERS: **the SPEED did not move.** The
// shipped record was pitch 32 / K 4 / quantum 6 = 8px every 6 sim ticks; the new record
// is period 16 / K 12 / quantum 1 = 1.333333px every sim tick. Both are 80 px/sec. The
// art-directed pace is unchanged and only the strobe is removed, so that is what
// is gated here - computed from the painter record on BOTH sides, so neither side can
// be satisfied by re-typing the answer.
//
// The FLOW-02 divisibility assertion stays and still binds: `pitch` must divide `CELL`
// (32) or the pattern jumps phase at every cell border. Its sibling - "`pitch / phases`
// is a positive integer step in whole px" - is RETIRED with its reason recorded below,
// not silently dropped.
//
// Skin sourcing follows `beltCorner.test.ts`: the SHIPPED `LOCKED_SKIN`, never a
// fixture skin - so nothing here can pass against a skin the app does not run.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHIPPED_PAINTER } from './beltPainter.ts';
import { LOCKED_SKIN } from './skins/locked.ts';
import { BELT_MARCH_BUCKETS, BELT_MARCH_QUANTUM_TICKS } from './beltGeometry.ts';
import { SIM_TICKS_PER_FRAME } from '../interp.ts';
// VEC-01 (plan 61-02): the straight families return tessellated contexts, so their
// callability is read back through Pixi's OWN measurement path rather than through a
// pixel-matrix shape - the `svgAssets.ts:290-302` discipline (never mirror the branch,
// read Pixi's answer back).
import { classifyVertexCount, measureContext } from '../svgAssets.ts';
import { BELT_DASH_PERIOD, CELL } from '../../../shared/geometry.ts';

/**
 * The px PER SIM TICK a march record describes, computed from the record ALONE.
 *
 * `advance per tick = pitch / phases` px held for `quantum` ticks, so the rate is
 * `(pitch / phases) / quantum`. This is the ONE expression under which the shipped
 * record and the 61-04 record are comparable at all, which is exactly why the speed
 * claim is stated through it rather than through either record's own knobs.
 *
 * **IT WAS `pxPerSecOf` AND MULTIPLIED BY A TICKS-PER-SECOND CONSTANT.** Phase 62
 * deleted that constant from the render path by derivation (D-05): the tread's rate
 * comes off the belt now, and per SIM TICK is the unit the march has. Dividing out the
 * seconds changes no comparison this block makes - both records are scaled by the same
 * figure - and it is what lets the block keep gating the split with no px/sec term
 * anywhere in `frontend/src`.
 */
function pxPerTickOf(rec: { phases: number; quantum: number; pitch: number }): number {
  return rec.pitch / rec.phases / rec.quantum;
}

describe('the split-knob march preserves the RECORD-LEVEL pace (BELT-06, plan 61-04)', () => {
  it('describes exactly the same per-tick pace the welded model did', () => {
    // The SHIPPED record, transcribed from 53-BELT-LOCK.md axis 4 rather than imported:
    // the whole point is that a record which no longer exists in code is still the
    // thing the new record is being compared against.
    //
    // 1.333333 px/tick is the welded model's 8px-every-6-ticks, and it is the pace the
    // deleted art-directed constant carried. **The PAINTER RECORD still describes it and
    // that is correct**: the record says how the pattern is quantized and held, not how
    // fast a belt runs. What Phase 62 moved is the ADVANCE, which is now a per-belt
    // derivation (`marchPxPerTick`) and is not in this record at all.
    const WELDED = { phases: 4, quantum: 6, pitch: 32 };
    expect(pxPerTickOf(WELDED)).toBeCloseTo(8 / 6, 12);
    expect(pxPerTickOf(SHIPPED_PAINTER)).toBeCloseTo(8 / 6, 12);
    expect(pxPerTickOf(SHIPPED_PAINTER)).toBeCloseTo(pxPerTickOf(WELDED), 12);
  });

  it('does it in 60 small steps a second instead of 10 big ones', () => {
    // THE ONLY THING THAT CHANGED, stated as a number: the step shrank by 6x and the
    // update rate grew by 6x. That product is what "the pace does not move, only the
    // strobe is removed" means arithmetically.
    const WELDED = { phases: 4, quantum: 6, pitch: 32 };
    const weldedStep = WELDED.pitch / WELDED.phases;
    const step = SHIPPED_PAINTER.pitch / SHIPPED_PAINTER.phases;
    expect(weldedStep).toBe(8);
    expect(step).toBeCloseTo(8 / 6, 12);
    expect(weldedStep / step).toBeCloseTo(WELDED.quantum / SHIPPED_PAINTER.quantum, 12);
  });

  it('is built from the shipped constants, not re-typed literals', () => {
    expect(SHIPPED_PAINTER.phases).toBe(BELT_MARCH_BUCKETS);
    expect(SHIPPED_PAINTER.quantum).toBe(BELT_MARCH_QUANTUM_TICKS);
    expect(SHIPPED_PAINTER.pitch).toBe(BELT_DASH_PERIOD);
    expect(SHIPPED_PAINTER.id).toBe('shipped');
    // ... and the values themselves, so a silent re-value of a source constant cannot
    // hide behind provenance (the `machineChassis.ts:44-57` counter-rule).
    expect(SHIPPED_PAINTER.phases).toBe(12);
    expect(SHIPPED_PAINTER.quantum).toBe(1);
    expect(SHIPPED_PAINTER.pitch).toBe(16);
  });

  it('no longer rides the MOTION-01 animation clock, and that is the DELIBERATE half', () => {
    // The retired coupling, asserted as an INEQUALITY so the decoupling is a gated fact
    // rather than a comment. `SIM_TICKS_PER_FRAME` is still imported here for exactly
    // this purpose: to state what the belt is no longer tied to.
    expect(SHIPPED_PAINTER.quantum).not.toBe(SIM_TICKS_PER_FRAME);
    expect(SIM_TICKS_PER_FRAME).toBe(6); // the 10fps machine lattice, unmoved
    // The belt's own clock is the SIM TICK, one per march step. This case used to close
    // by pinning a ticks-per-second constant at 60; Phase 62 deleted every
    // ticks-per-second figure from the render path (D-05), and the claim that survives
    // is the one that was ever load-bearing: the belt marches on the sim tick lattice
    // and the machine sprites do not.
    expect(BELT_MARCH_QUANTUM_TICKS).toBe(1);
    expect(Number.isInteger(SIM_TICKS_PER_FRAME / BELT_MARCH_QUANTUM_TICKS)).toBe(true);
  });
});

describe('SHIPPED_PAINTER geometry invariants (FLOW-02 tiling)', () => {
  it('pitch divides CELL, so a per-tile asset tiles seamlessly across a cell border', () => {
    expect(CELL % SHIPPED_PAINTER.pitch).toBe(0);
  });

  it('RETIRED: pitch / phases is no longer required to be a whole number of px', () => {
    // The sibling assertion here used to require `pitch / phases` to be a positive
    // INTEGER step. That constraint was a property of a RASTER tread: a bake shifts by
    // whole pixel columns or not at all, so a fractional step was unrepresentable.
    // VEC-01 removed the raster tread, and plan 61-04's whole purpose is a step FINER
    // than one px - 1.333333 at the shipped rate. Keeping the integer requirement would
    // have forbidden the fix; weakening it silently would have deleted a real guard
    // without saying so. It is retired, and this case records the retirement.
    const step = SHIPPED_PAINTER.pitch / SHIPPED_PAINTER.phases;
    expect(Number.isInteger(step)).toBe(false);
    expect(step).toBeGreaterThan(0);
    // What still binds, and it is the property the integer rule was standing in for:
    // the step must be positive and must divide the pattern period a whole number of
    // times, or the march would not close its own loop.
    expect(Number.isInteger(SHIPPED_PAINTER.pitch / step)).toBe(true);
  });
});

describe('SHIPPED_PAINTER assets are callable against the shipped skin', () => {
  // VEC-01. Plan 61-02 split this case in two because the straight families had gone
  // vector while the corner families were still raster `PixelMatrix` bakes. Plan 61-03
  // converted the corners, so the four families share ONE return type again and the
  // two halves REJOIN rather than one being deleted: the CELL-square matrix assertion
  // has no subject left (a `GraphicsContext` has no pixel rows), and the property it
  // stood for - the family is callable against the shipped skin and produces a real,
  // non-empty asset - is now asserted for all four in the one shape they share.
  it('produces a NON-EMPTY tessellated context from all FOUR vector families', () => {
    // Non-emptiness is the assertion that matters for a procedural builder: a context
    // that tessellates to nothing draws nothing while passing every vertex budget by
    // being under all of them. `assertVertexBudget` already throws on that inside the
    // painter under DEV; this is the second net, in the painter's own suite.
    for (const [name, ctx] of [
      ['straight', SHIPPED_PAINTER.straight(LOCKED_SKIN, 0, CELL)],
      ['straightTick', SHIPPED_PAINTER.straightTick(LOCKED_SKIN, CELL)],
      ['corner cw', SHIPPED_PAINTER.corner(LOCKED_SKIN, 0, 'cw', CELL)],
      ['corner ccw', SHIPPED_PAINTER.corner(LOCKED_SKIN, 1, 'ccw', CELL)],
      ['cornerTick cw', SHIPPED_PAINTER.cornerTick(LOCKED_SKIN, 'cw', CELL)],
      ['cornerTick ccw', SHIPPED_PAINTER.cornerTick(LOCKED_SKIN, 'ccw', CELL)],
    ] as const) {
      const m = measureContext(ctx);
      expect(m.vertexCount, `${name} tessellates to real geometry`).toBeGreaterThan(0);
      expect(classifyVertexCount(m.vertexCount), `${name} vertex band`).toBe('ok');
    }
  });

  it('keeps the CORNER inside the VEC-04 batching budget at every march bucket', () => {
    // The corner is the only belt asset with real sample-count sensitivity: at
    // ARC_SAMPLES = 24 it measures in the 264-284 band against a 300 warn / 400 fail
    // ceiling, so there is roughly one sample step of headroom and it is worth a gate
    // rather than a docblock. Swept over EVERY bucket and both chiralities, because
    // the vertex count moves with how many dash sectors the phase puts on the arc.
    for (const chirality of ['cw', 'ccw'] as const) {
      for (let phase = 0; phase < SHIPPED_PAINTER.phases; phase++) {
        const m = measureContext(SHIPPED_PAINTER.corner(LOCKED_SKIN, phase, chirality, CELL));
        expect(
          classifyVertexCount(m.vertexCount),
          `corner ${chirality} bucket ${phase} measured ${m.vertexCount} vertices`,
        ).toBe('ok');
      }
    }
  });

  it('is frozen, so a variant can never mutate the default in place', () => {
    expect(Object.isFrozen(SHIPPED_PAINTER)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE SEAM IS THE LAYER'S ONLY PATH TO BELT GEOMETRY (plan 61-09)
// ---------------------------------------------------------------------------
//
// A SOURCE GUARD, because this is a claim about what the layer may REACH and no runtime
// assertion can see an import that simply is not there yet. It is the same shape
// `render/vectorOnly.test.ts` uses for the VEC-01 exemption list, and it is here rather
// than there because the property is about the PAINTER seam and not about matrices.
//
// WHY IT MATTERS MORE AFTER 61-09 THAN BEFORE. The rails became a device-quantum-aware
// family, so there are now two plausible ways for the layer to obtain a rail: through
// `painter.rails(skin, q)`, or by importing `railCommands` and inking it locally. The
// second would give the shipped look and every variant look two different drift
// surfaces - which is the exact defect the seam was promoted (Phase 53) to remove, and
// the one `add-alongside` was refused for.
describe('the belt LAYER reaches geometry only through the painter seam', () => {
  const LAYER_SOURCE = readFileSync(
    join(import.meta.dirname, '..', 'layers', 'belts.ts'),
    'utf8',
  );

  /**
   * Every EMITTER `beltGeometry.ts` exports. The layer may import the module's MARCH
   * ARITHMETIC (`bucketOf`, `tileFlowLength`, `resyncLurchPx`) and does - plan 61-04 put
   * that arithmetic there deliberately, and it emits no geometry. What it may not import
   * is anything that produces a path.
   */
  const EMITTERS = [
    'railCommands',
    'railBandAt',
    'straightCommands',
    'straightTickCommands',
    'cornerCommands',
    'cornerTickCommands',
    'cornerRailCommands',
    'sampleArcPoints',
  ];

  it('imports no path emitter from the geometry module', () => {
    // Scan the IMPORT STATEMENTS only, so the words may still appear in the layer's
    // prose - which they do, at length, and must be allowed to.
    const imports = LAYER_SOURCE.split('\n')
      .filter((l) => /^import\s/.test(l) || /^\s+[A-Za-z]+,?$/.test(l))
      .join('\n');
    for (const emitter of EMITTERS) {
      expect(
        new RegExp(`\\b${emitter}\\b`).test(imports),
        `belts.ts imports the emitter ${emitter} - it must go through painter.* instead`,
      ).toBe(false);
    }
  });

  it('refuses a vacuous pass: the scanner FIRES on a real emitter import', () => {
    // Without this the case above would pass on an empty file, a moved path, or a
    // regex that matches nothing - the silent-green failure mode a source guard is
    // most exposed to.
    // THE ANCHOR MOVED IN PLAN 62-01 AND AGAIN IN 62-04, AND THE CONTROL WAS UPDATED
    // BOTH TIMES, WHICH IS WHAT THE MESSAGE BELOW ASKS FOR. 62-01 pushed the import
    // into the braced multi-line form; 62-04 deleted the member it anchored on (the
    // art-directed base march advance the layer used to import) by derivation (D-05)
    // and the first braced member became the aliasing ceiling. The control anchors on
    // the FIRST braced member rather than on the whole statement, so a further member
    // arriving cannot silently turn this case vacuous - and the assertion below fails
    // LOUDLY, naming the remedy, when the anchor moves again.
    const ANCHOR = '  MARCH_NYQUIST_CEILING_PX_PER_TICK,\n';
    const mutated = LAYER_SOURCE.replace(ANCHOR, `${ANCHOR}  railCommands,\n`);
    expect(mutated, 'the anchor import line moved - update this control').not.toBe(
      LAYER_SOURCE,
    );
    const imports = mutated
      .split('\n')
      .filter((l) => /^import\s/.test(l) || /^\s+[A-Za-z]+,?$/.test(l))
      .join('\n');
    expect(/\brailCommands\b/.test(imports)).toBe(true);
  });

  it('names every rail family the seam must carry, so a fifth cannot arrive silently', () => {
    // The painter record is the closed set of ways a belt can be painted. A rail method
    // added to the layer without a matching method here would be a family with no
    // digest row and no vertex budget.
    for (const method of ['straight', 'straightTick', 'corner', 'cornerTick', 'rails']) {
      expect(typeof (SHIPPED_PAINTER as unknown as Record<string, unknown>)[method]).toBe(
        'function',
      );
    }
  });
});
