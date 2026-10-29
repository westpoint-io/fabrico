// SAFE-02 reduced-motion mapping — the pure decision the App effect calls.
//
// The project principle "keep the core pure, add impurities on top of purities": the
// synth/render pipeline stays PURE and untouched; reduced motion is a thin top
// layer that pins the render clock (gate 1) AND freezes the overlay wall clock
// (gate 2) at their source. This module is that decision, extracted so the App
// effect stays a thin caller and the frame choice is unit-testable in isolation:
// NO DOM, NO React, NO matchMedia read here — just `matches: boolean -> pins`.

import { SIM_TICKS_PER_FRAME } from '../render/interp';

/**
 * The representative render-clock value pinned under prefers-reduced-motion (in
 * sim-tick units, the unit `pinClock` consumes). It is `SIM_TICKS_PER_FRAME * 3`,
 * i.e. MOTION-01 frame index 3 — the fault-alarm envelope's PEAK at zero phase
 * offset (faultBlink.ts ATTACK=3), so a frozen faulted machine reads at its most
 * prominent "ON" rather than the dim floor.
 *
 * Legibility is guaranteed at ANY frame, not just this one: `faultBlinkAlpha` has
 * a non-zero FLOOR (0.25), so no per-node phase offset can ever land a faulted
 * machine at alpha 0 (mid-blink-OFF) on the frozen frame — the fault marker's
 * colour + shape always survive the freeze (VIS-03 redundancy). The WORKING
 * emerald tint and the machine identity glyph are frame-INDEPENDENT (Phase 33),
 * so they are unaffected by whichever frame we pin. reducedMotion.test.ts asserts
 * both the peak choice and the fault-never-off invariant against faultBlink.ts.
 */
export const REDUCED_MOTION_FRAME = SIM_TICKS_PER_FRAME * 3; // 18

/** The two pins the App effect applies from a single matchMedia read. */
export interface ReducedMotionPins {
  /** pinClock(frame) target, or null to restore the live render clock (gate 1). */
  frame: number | null;
  /**
   * pinOverlay(overlayFrozen): quiet the overlay's wall-clock PULSES (gate 2).
   * Since Phase 64 this is a flag handed to `overlay.tick`, not a frozen
   * timestamp fed in its place: the overlay's clock keeps advancing, so the
   * 180ms reject flash and the 5000ms alert settle still elapse under reduced
   * motion, and only the two sinusoid alphas are held (SAFE-02, D-25).
   */
  overlayFrozen: boolean;
}

/**
 * Pure mapping from the media-query match to BOTH reduced-motion gates.
 *
 * `reducedMotionPins(true)`  -> freeze: pin the render clock to the representative
 *                               frame AND freeze the overlay wall clock.
 * `reducedMotionPins(false)` -> live:   release the render clock (null) AND unfreeze
 *                               the overlay.
 *
 * Both gates move together off the ONE `matches` read, so belts/items/fault-blink
 * (gate 1) and the overlay alert-ring (gate 2) freeze and thaw in lockstep — the
 * two-gate contract RESEARCH Pitfall 2 requires. No DOM/React here (testable pure).
 */
export function reducedMotionPins(matches: boolean): ReducedMotionPins {
  return matches
    ? { frame: REDUCED_MOTION_FRAME, overlayFrozen: true }
    : { frame: null, overlayFrozen: false };
}
