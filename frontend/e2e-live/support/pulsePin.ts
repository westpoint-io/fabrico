// pulsePin.ts - the grade of lesson 5's reply-comet read, pure: plain data in, sentences out.
//
// WHY THE READ IS PINNED. The walk used to read the four return-cable tiles in frames back to back
// across a 1.5 s window, on its own schedule, and hope a frame landed while the comet crossed them. On
// the CI runner each synchronous canvas read blocked the page for 292 to 336 ms (run 43670312713), so
// the window held 4 frames 20 to 25 ticks apart, and the comet, which sits on the read tiles for about
// 9.5 of its 28 render-clock units, passed between two of them. Locally the same window held 87 to 91
// frames, about one a tick. The product drew the comet; the read missed it.
//
// So the walk pins the render clock before the POST, waits for the return wire's reply count to rise
// (the wire layer latches the comet at the pinned value, frac 0 on the Handler's nub), then steps the
// pin one unit at a time and reads the tiles after each step. What each step draws no longer depends
// on how fast the runner draws frames. The walk's lesson runner takes the reads; this module applies
// every rule to the numbers, so `src/gates/pulsePin.test.ts` can pin each rule on traces written by
// hand. No Playwright, no PNG decoder and no import from the renderer here.
//
// THE RULES, in the order they are checked:
//   1. No step reads a cleared buffer.
//   2. Step 0 holds no comet ink: the comet has not left the Handler's nub yet.
//   3. At least PULSE_LIT_STEPS_MIN of steps 1 to PULSE_SWEEP_UNITS are lit (changed by more than
//      PULSE_DELTA_MIN pixels against step 0 and holding more than PULSE_WARM_MIN amber pixels above
//      the frame before the POST).
//   4. No step past PULSE_SWEEP_UNITS is lit: the comet retires when it reaches the Route.
//   5. The first tile (the Handler's end) and the last tile both light, and the first lights at an
//      earlier step than the last, so the comet is shown heading home.

/**
 * Render-clock units the wire layer sweeps a comet over, end to end (its `VISUAL_HOP_TICKS`, restated
 * here so the grader stays off the renderer). The comet retires at this step.
 */
export const PULSE_SWEEP_UNITS = 28;
/** Pinned steps read after step 0: the whole sweep and four steps after the comet retires. */
export const PULSE_PIN_STEPS = 32;
/**
 * A step differs from step 0 when more than this many pixels changed. Six measuring runs on lesson 5's
 * four read tiles: a drawn comet changed 134 to 137 pixels in 10 frames each (about 106 of them amber),
 * and a request with no comet drawn changed 0 pixels in every one of 89 to 91 frames. CI run 43670312713
 * read 0 changed pixels in its 4 frames because none of them caught the comet, not because the floor
 * was wrong.
 */
export const PULSE_DELTA_MIN = 20;
/**
 * A lit step must also hold more than this many amber pixels above the frame before the POST, so the
 * change on the return cable is the reply comet's ink and not a forward spark, a hover mark or an outline
 * that a later routing or floor change put on a read tile. Measured on lesson 5 at `ffa6fd9` (seven runs)
 * and `df60bec` (three walks): the changed frames held 57 to 107 amber pixels, at least five frames per
 * request above 50, and the baseline held 0. In CI run 43670312713 the frame before the POST held 0 too.
 */
export const PULSE_WARM_MIN = 50;
/**
 * Lit steps the sweep must show. The head spends about 9.5 of its 28 units on the four read tiles, so
 * about 9 to 10 steps light; 3 leaves room for a different camera scale without passing on a flicker.
 */
export const PULSE_LIT_STEPS_MIN = 3;
/** A tile counts as lit at the first step whose amber on it exceeds its own step-0 amber by more than this. */
export const PULSE_TILE_WARM_MIN = 20;

/** One pinned step's read of the four return-cable tiles. */
export interface PinnedStep {
  /** Render-clock units past the pin the comet latched at. */
  k: number;
  /** The read found a cleared buffer, so its pixels tell nothing. */
  flat: boolean;
  /** Pixels changed against the step-0 frame, summed over the tiles. */
  delta: number;
  /** Amber pixels summed over the tiles. */
  warm: number;
  /** Amber pixels per tile, in the order the return wire's path lists them, from the Handler's end. */
  tileWarm: number[];
}

/** What the MEASURE line reports. */
export interface PinnedSummary {
  lit: number;
  firstLit: number | null;
  lastLit: number | null;
  /** Each tile's first lit step, or null when it never lit. */
  tileFirst: Array<number | null>;
  maxWarm: number;
}

function isLit(s: PinnedStep, beforeWarm: number): boolean {
  return !s.flat && s.delta > PULSE_DELTA_MIN && s.warm > beforeWarm + PULSE_WARM_MIN;
}

function tileFirstLit(steps: readonly PinnedStep[]): Array<number | null> {
  const anchor = steps.find((s) => s.k === 0);
  const tiles = anchor?.tileWarm.length ?? steps[0]?.tileWarm.length ?? 0;
  const out: Array<number | null> = [];
  for (let t = 0; t < tiles; t++) {
    const base = anchor?.tileWarm[t] ?? 0;
    const hit = steps.find((s) => s.k > 0 && !s.flat && (s.tileWarm[t] ?? 0) - base > PULSE_TILE_WARM_MIN);
    out.push(hit === undefined ? null : hit.k);
  }
  return out;
}

/** The counts for the MEASURE line. */
export function pinnedPulseSummary(steps: readonly PinnedStep[], beforeWarm: number): PinnedSummary {
  const lit = steps.filter((s) => s.k >= 1 && s.k <= PULSE_SWEEP_UNITS && isLit(s, beforeWarm));
  return {
    lit: lit.length,
    firstLit: lit.length === 0 ? null : lit[0]!.k,
    lastLit: lit.length === 0 ? null : lit[lit.length - 1]!.k,
    tileFirst: tileFirstLit(steps),
    maxWarm: Math.max(0, ...steps.map((s) => s.warm)),
  };
}

/**
 * Every rule the steps break, as sentences saying what the screen showed; empty for a pass.
 * `beforeWarm` is the amber on the tiles in the frame before the POST.
 */
export function pinnedPulseFindings(steps: readonly PinnedStep[], beforeWarm: number): string[] {
  const findings: string[] = [];
  for (const s of steps) {
    if (s.flat) findings.push(`step ${s.k} read a cleared buffer, so its tiles tell nothing`);
  }
  const anchor = steps.find((s) => s.k === 0);
  if (anchor === undefined) {
    findings.push('no step 0 was read, so nothing marks where the comet starts');
  } else if (!anchor.flat && anchor.warm > beforeWarm + PULSE_WARM_MIN) {
    findings.push(
      `step 0 already holds ${anchor.warm} amber pixels on the read tiles against ${beforeWarm} before the POST (floor ${PULSE_WARM_MIN} above), so comet ink is there before the comet leaves the Handler`,
    );
  }
  const inSweep = steps.filter((s) => s.k >= 1 && s.k <= PULSE_SWEEP_UNITS);
  const lit = inSweep.filter((s) => isLit(s, beforeWarm));
  if (lit.length < PULSE_LIT_STEPS_MIN) {
    const changed = inSweep.filter((s) => !s.flat && s.delta > PULSE_DELTA_MIN).length;
    const maxWarm = Math.max(0, ...inSweep.map((s) => s.warm));
    const maxDelta = Math.max(0, ...inSweep.map((s) => s.delta));
    if (changed >= PULSE_LIT_STEPS_MIN) {
      findings.push(
        `${changed} steps changed by more than ${PULSE_DELTA_MIN} pixels against step 0, but only ${lit.length} held more than ${PULSE_WARM_MIN} amber pixels above the ${beforeWarm} before the POST (most amber ${maxWarm}, need at least ${PULSE_LIT_STEPS_MIN} lit steps), so what crossed the return cable was not the reply comet's ink`,
      );
    } else {
      findings.push(
        `${lit.length} of steps 1 to ${PULSE_SWEEP_UNITS} held comet ink on the return cable's read tiles, need at least ${PULSE_LIT_STEPS_MIN} (largest change ${maxDelta} pixels against step 0, most amber ${maxWarm})`,
      );
    }
  }
  for (const s of steps) {
    if (s.k > PULSE_SWEEP_UNITS && isLit(s, beforeWarm)) {
      findings.push(
        `step ${s.k} still holds comet ink (${s.delta} pixels changed, ${s.warm} amber), past the ${PULSE_SWEEP_UNITS}-unit sweep, so the comet never retired at the Route`,
      );
    }
  }
  const tileFirst = tileFirstLit(steps);
  if (tileFirst.length > 0) {
    const first = tileFirst[0]!;
    const last = tileFirst[tileFirst.length - 1]!;
    if (first === null || last === null) {
      findings.push(
        `the first tile (Handler end) lit at step ${first ?? 'none'} and the last tile at step ${last ?? 'none'} (each needs more than ${PULSE_TILE_WARM_MIN} amber pixels over its step-0 amber), so the comet was not seen crossing the read tiles`,
      );
    } else if (first >= last) {
      findings.push(
        `the last tile lit at step ${last} and the first tile at step ${first}, so the comet crossed the read tiles from the Route's end and not home from the Handler`,
      );
    }
  }
  return findings;
}
