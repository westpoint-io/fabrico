// The MOTION-03 fault-blink cadence contract (docs/style-bible.md section 4).
//
// This is the pure render kernel the bible's fault-cadence table row points to:
// a deliberate ASYMMETRIC alarm envelope (fast attack, slow release, hold at a
// non-zero floor) plus a deterministic per-node phase desync. It is a sibling to
// `interp.ts` `quantizedFrame` - NO Pixi import, integer/float math render-side
// only, a pure function of the pinned sim-frame clock (never a wall clock), so
// the blink is fully replayable and freezes for free when the sim pauses.
//
// Two deliberate departures, both research-backed:
//   1. The alpha is applied by the machine layer as a `sprite.alpha` OVERLAY
//      modulation (render-time compositing), NOT baked as 24 body-texture alpha
//      variants. `sprite.alpha` is categorically different from the banned synth
//      byte-multiply (bible section 7), and it keeps the body cache tiny while
//      preserving colour + shape at the trough for free (the steady fault trim is
//      baked into the FAULTED body; this module only shapes the pulse on top).
//   2. `phaseOffset` keys on the STABLE origin cell `(cellX, cellY)`, never
//      `node.id` - the render handle is re-minted on every keyframe (undo / redo /
//      load, App.tsx), so hashing it would make every fault's phase JUMP on those
//      events. The spatial key keeps a machine that stays put at a stable phase
//      while adjacent cells still hash to well-separated phases (Pitfall 2).

/**
 * The bounded animation loop length, in MOTION-01 frames - identical to
 * `interp.ts` FRAMES (24). The whole fault cadence is periodic in this count, so
 * `faultBlinkAlpha(f) === faultBlinkAlpha(f + FRAMES)` and the per-node offset is
 * taken modulo FRAMES. At the shared 10fps quantized cadence one loop is 2.4s.
 */
export const FRAMES = 24;

/** The non-zero alpha floor - the fault stays visible (colour + shape) at the
 * trough and when paused. Combined with the steady baked trim this is the
 * VIS-03 colour-blind redundancy guarantee: the alarm can never become invisible. */
const FLOOR = 0.25;

/** The capped peak alpha - a deliberate ceiling (< 1.0) so the blink never
 * blinds or reads as a full keyframe flash; it is an accent pulse, not a strobe. */
const PEAK = 0.8;

/** Attack length in frames (fast rise floor -> peak). ~0.3s at 10fps. */
const ATTACK = 3;
/** Release length in frames (slow decay peak -> floor). ~1.1s at 10fps.
 * ATTACK < RELEASE is the hard asymmetry invariant: an alarm snaps ON and eases
 * OFF, never a symmetric sine "breathe". */
const RELEASE = 11;

/**
 * The asymmetric fault-alarm alpha envelope as a PURE function of `localFrame`
 * (the per-node phase-shifted frame index). Shape over one FRAMES=24 loop:
 *
 *   frames [0, ATTACK)          fast attack  - rise FLOOR -> PEAK
 *   frames [ATTACK, ATTACK+REL) slow release - decay PEAK -> FLOOR
 *   frames [ATTACK+REL, FRAMES) hold         - rest at FLOOR
 *
 * Invariants (unit-asserted): ATTACK < RELEASE (asymmetric), peak <= PEAK (0.8)
 * and never 1.0, floor > 0 (0.25) and never 0.0, pure, and Euclidean-safe on
 * negative / out-of-range / fractional inputs (floor then wrap into [0, FRAMES)).
 *
 * The exact frame counts are feel-tunable within those invariants; these were
 * authored against the bible's 10fps / 24-frame band (Phase 26).
 */
export function faultBlinkAlpha(localFrame: number): number {
  // Floor fractional inputs, then Euclidean-wrap into [0, FRAMES) (negative-safe).
  const q = Math.floor(localFrame);
  const f = ((q % FRAMES) + FRAMES) % FRAMES;
  if (f < ATTACK) {
    // Fast attack: linear FLOOR -> PEAK over ATTACK frames (f=0 at FLOOR).
    return FLOOR + (PEAK - FLOOR) * (f / ATTACK);
  }
  if (f < ATTACK + RELEASE) {
    // Slow release: linear PEAK -> FLOOR over RELEASE frames (f=ATTACK at PEAK).
    return PEAK - (PEAK - FLOOR) * ((f - ATTACK) / RELEASE);
  }
  // Hold at the floor for the remainder of the loop.
  return FLOOR;
}

/**
 * A deterministic per-node blink phase offset in `[0, FRAMES)`, derived from the
 * STABLE origin cell so a grid full of faults never reads as one synchronized
 * pulse. Inline FNV-1a 32-bit hash over the string `"cellX,cellY"` (NON-crypto,
 * a phase-desync hash only - never a security primitive), mod FRAMES. No hashing
 * dependency: a 5-line pure hash is the right tool for a phase offset.
 *
 * Keyed on the origin cell (not `node.id`): a machine that stays put keeps its
 * phase across undo / redo / load, while adjacent cells hash to well-separated
 * phases (Pitfall 2). Same cell -> same offset on every replay.
 */
export function phaseOffset(cellX: number, cellY: number): number {
  let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
  const s = `${cellX},${cellY}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime, 32-bit via Math.imul
  }
  return (h >>> 0) % FRAMES;
}
