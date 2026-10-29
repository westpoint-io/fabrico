// The Ticker render loop (VIS-01) — the heartbeat that draws the scene every
// DISPLAY frame, decoupled from the 60-tick sim.
//
// Each frame it advances the render clock toward the latest received sim tick
// (advanceRenderClock keeps a ~1-tick lag buffer so a late packet never stalls
// motion), then redraws: item dot positions at their SLOT-TRUE belt slots
// (slotArcLength, SKIN-03 — analytically recomputed every frame), the machine
// working-sweep by the quantized render clock, and the overlay alert-ring pulse by
// a wall-clock phase (cosmetic, continuous even when the sim is paused). The render
// clock still snaps rather than lerps across a discontinuity — that guard lives in
// advanceRenderClock (a backward collapse of latestSimTick snaps the clock back).
//
// SAFE-02 reduced motion: the loop exposes TWO independent gates. `pinClock`
// freezes the render clock (belts/items/machine sweep/fault blink); `pinOverlay`
// quiets the overlay's separate wall-clock PULSES (alert ring, pending shimmer).
// The overlay is the one deliberate wall-clock exception pinClock does NOT cover,
// so honoring prefers-reduced-motion needs both — the App effect pins them
// together. The two gates are NOT the same shape: gate 2 passes a flag and lets
// the overlay's clock run (D-25), because the overlay also owns time-limited
// affordances — a 180ms reject flash and a 5000ms alert pulse settle — and freezing the
// clock froze those too, leaving both painted for the rest of the session.

import type { Application } from 'pixi.js';
import { advanceRenderClock, LAG_TICKS, quantizedFrame } from './interp';
import type { SceneState } from './sceneState';
import type { MachineLayer } from './layers/machines';
import type { BeltLayer } from './layers/belts';
import { ITEM_INTERPOLATION_DEFAULT, type ItemLayer } from './layers/items';
import type { WireLayer } from './layers/wires';

/**
 * ms per sim tick — the RENDER CLOCK's smoothing coefficient, and nothing more.
 *
 * The clock advances by `deltaMs / SIM_TICK_MS` tick-units per DISPLAY frame, so this
 * figure sets how fast the render clock walks toward the live scene tick between
 * packets. It is NOT a claim about the host's cadence: the sim loop actually runs at
 * ~62.5 t/s (`crates/fabrico-host/src/sim_loop.rs`), and nothing here reads or should
 * read the true rate, because the clock is corrected by the arriving tick rather than
 * predicted from a rate.
 *
 * **DELIBERATELY UNTOUCHED BY PHASE 62, and this paragraph is why** (`62-CONTEXT.md`
 * "reconcile the tick rate ONCE by measurement"). Plan 62-04 deleted the render path's
 * ticks-per-second constants by derivation (D-05): the tread's advance is now a
 * per-belt quantity in px per SIM TICK, so no conversion needs a host rate at all. That
 * deletion removes the reconciliation instead of performing it. Re-pointing this
 * constant at 62.5 would be "finishing the job" on a constant that was never doing that
 * job, and would silently re-time every layer's resynchronisation.
 */
export const SIM_TICK_MS = 1000 / 60;

/**
 * If the render clock falls more than this many sim ticks behind the live scene tick,
 * snap forward instead of crawling toward it one display-frame at a time. This is the
 * case when the frontend connects to a sim already running at a high tick, when the tab
 * was backgrounded, or when the sim advances faster than the display refreshes.
 * Without the snap, the quantized machine-sweep frame would crawl visibly out of step
 * with the live sim.
 *
 * EXPORTED BY PLAN 61-04, and the export is the point rather than a convenience. This
 * integer is the whole of the belt's RESYNC LURCH: a snap of `RESYNC_GAP_TICKS` ticks
 * displaces the tread by `RESYNC_GAP_TICKS * <that belt's px-per-tick>` px in one frame
 * (per belt since Phase 62, D-05: it names a module constant no longer, because there
 * is no module constant - see `belts.ts marchResyncLurchPx`),
 * and `belts.ts` requires any painter proposing a sub-6 quantum to PUBLISH that number
 * beside its speed. Publishing it as a re-typed 6 in the belt layer would have let the
 * gap and the published metric drift apart silently, which is the one failure the
 * published metric exists to prevent. It stays a `loop.ts` constant because machines
 * ride the same snap, and RAISING it to soften the belt's lurch is explicitly rejected
 * (`61-RESEARCH.md` Pitfall 6 option b): it is a loop-level global, not a belt knob.
 */
export const RESYNC_GAP_TICKS = 6;

export interface RenderLoop {
  /** Current render clock (sim-tick units) — exposed for drawScene/tests. */
  renderClock(): number;
  /**
   * MOTION-04 deterministic frame readout: the quantized MOTION-01 frame index of
   * the EFFECTIVE clock (`pinnedClock ?? clock`). Every downstream frame probe
   * (belt march, fault blink, working sweep) reads its phase off this index, so a
   * test can pin the clock and assert an exact integer frame with no pixels.
   */
  frame(): number;
  /**
   * MOTION-04 render-clock pin (production-inert). `pinClock(n)` overrides ONLY
   * the render frame every sim-clock consumer derives (machines/belts/items) so a
   * probe can freeze a deterministic frame; `pinClock(null)` (the default) restores
   * the live clock-derived behavior. It writes ONLY the render clock — never
   * `scene.tick`, never a GridCommand, never the event log (threat T-26-01) — so it
   * is inert in production and cannot become a determinism/tamper backdoor. The
   * overlay wall-clock pulse is deliberately NOT pinned.
   */
  pinClock(n: number | null): void;
  /**
   * SAFE-02 second reduced-motion gate (the deliberate wall-clock exception the
   * pinClock seam does NOT cover). `pinOverlay(true)` quiets the overlay's PULSES
   * by passing a frozen flag to `overlay.tick`; `pinOverlay(false)` (the default)
   * lets them animate. The `nowMs` fed to the overlay ALWAYS advances, in both
   * states — that is the whole point of the split (D-25). Holding the pulse is
   * what reduced motion asks for; holding the clock also stopped the 180ms reject
   * flash from decaying and drove the alert ring's elapsed negative, so neither ever
   * expired and both stayed painted for the rest of the session.
   * It is INDEPENDENT of pinClock/effectiveClock — it writes ONLY the overlay's
   * motion flag, never the machines/belts/items draws, never `scene.tick`, a
   * GridCommand, or the event log (threat T-34-DET). Under
   * `prefers-reduced-motion` the App pins BOTH gates so the overlay pulse quiets
   * together with belts/items/fault-blink (RESEARCH Pitfall 2: freezing the render
   * clock alone leaves this wall-clock pulse still animating).
   */
  pinOverlay(frozen: boolean): void;
  /**
   * SLOT-04 trailing item-interpolation toggle (production-inert, D-10).
   *
   * `setItemInterpolation(true)` makes each item dot GLIDE from the slot it was in to
   * the slot it is in over that belt's own advance interval; `(false)`, THE DEFAULT
   * ({@link ITEM_INTERPOLATION_DEFAULT}), draws every dot at its current slot exactly as
   * the pre-Phase-62 renderer did, with no lerp arithmetic on the path at all.
   *
   * IT IS BUILT ON `pinClock`'S MODEL RATHER THAN ON A BUILD GATE, and the argument
   * transfers exactly: it writes ONLY a render-side boolean that the item layer reads
   * when placing dots - never `scene.tick`, never a GridCommand, never the event log
   * (threat T-62-15) - so it is inert in production and cannot become a
   * determinism/tamper backdoor. Inertness is the proof, not absence. A DEV-only build
   * gate would ALSO have been wrong here for a measured reason: `import.meta.env.DEV` is
   * statically false in the production bundle the real WebKitGTK binary embeds, which is
   * the ONLY build the maintainers' judgement calls were ever held on (62-CONTEXT.md D-16,
   * measured).
   *
   * IT STILL HAS LIVE CALLERS after plan 68-07. It is exposed on the always-shipped
   * `window.__fabrico` surface (`chrome/App.tsx`) and driven by
   * `e2e-live/06-fault-red-probe.spec.ts`, so unlike its sibling below this is not an
   * orphan and needs no orphan note. `68-UI-SPEC.md` section 6.2 predicted it would lose
   * its only caller with the development pace switch; that prediction was MEASURED WRONG
   * before the deletion landed and the two callers above are why.
   *
   * IT WAS DECIDED AT THE SITTING ON 2026-08-14 AND SMOOTHING DOES NOT SHIP. The toggle
   * existed so the maintainers could decide (D-10) and they did, on the real WebKitGTK binary:
   * `62-SITTING-VERDICT.md` records "Trailing interpolation ships: NO - it stays built,
   * renderer-only and defaulted OFF". The measured cause is in `62-INTERP-VERDICT.md` and
   * the full account sits on {@link ITEM_INTERPOLATION_DEFAULT}, which is where the
   * default lives. The hook stays, production-inert, so the capability can be turned ON
   * for a later evaluation once the wire carries a stable per-item id.
   */
  setItemInterpolation(on: boolean): void;
  /**
   * SLOT-03 pre-Phase-62 TREAD-APPEARANCE override (production-inert, D-18).
   *
   * `setTreadAppearanceOverride(px)` makes every belt paint its tread at `px` world px
   * per sim tick instead of at the rate derived from that belt's own wire fields;
   * `setTreadAppearanceOverride(null)`, THE DEFAULT, restores the wire-derived rate and
   * is what every shipped build runs.
   *
   * **A DELIBERATELY-RETAINED INSTRUMENT HOOK WITH NO LIVE CALLER (68-UI-SPEC 6.2).**
   * Plan 68-07 deleted the define-gated panel that was the only thing that ever passed
   * it a number, and nothing else calls it today: the sole in-tree consumers are the
   * pass-through on `RendererHandle` and the belt layer's `treadPxPerTickOverride`
   * parameter, which every shipped caller leaves `null`/absent. It is KEPT rather than
   * deleted because it is the render-side half of a matched pair with
   * {@link RenderLoop.setItemInterpolation} above, which does still have callers, and
   * because the appearance question it was built to make askable can be asked again
   * without rebuilding the mechanism. **It is an instrument hook, not an orphan** - and
   * that distinction is written here rather than left to the next reader to guess, which
   * is exactly what 68-UI-SPEC 6.2 rules out.
   *
   * **THIS HOOK CARRIES NO FIGURE OF ITS OWN AND MUST NOT ACQUIRE ONE.** It defaults to
   * `null`, and the one copy of the superseded art rate that used to be passed to it was
   * deleted along with the panel that held it - so today there is no such figure anywhere
   * in the tree. Putting a number here would reinstate, in the render path, exactly the
   * module rate constant plan 62-04 deleted by derivation - and 62-04's grep would still
   * be green, because the symbol name would differ. Do not reintroduce that figure into
   * this file.
   *
   * WHY IT EXISTS AT ALL. Plan 62-04 derives the tread from item speed, so as of wave 3
   * the painted tread runs at roughly six times the appearance the maintainers have been
   * looking at, while the item pace is still today's. FEEL row 60-a (D-18) is asked
   * FIRST, at today's shipped pace, precisely because that anchor becomes permanently
   * unreachable afterwards - and it would otherwise be asked on a board that no longer
   * LOOKS like today's. This restores the appearance so the anchor is askable.
   *
   * It is built on `pinClock`'s model and the argument transfers exactly: it writes ONLY
   * a render-side number the belt layer reads when deriving a march advance - never
   * `scene.tick`, never a GridCommand, never the event log (threat T-62-15) - so it is
   * inert in production. That inertness is why it could be KEPT when the development
   * pace switch it once served was removed: that switch wrote SIM state unlogged and had
   * to go (BELT-05 / D-68-12); this writes a render-side number and never leaves the
   * render path.
   */
  setTreadAppearanceOverride(pxPerTick: number | null): void;
  stop(): void;
}

/**
 * Start the per-frame loop against a live scene buffer. `getScene` returns the
 * current SceneState (07-08 mutates it as packets arrive); the loop never writes
 * it — it only reads + draws.
 */
export function startRenderLoop(
  app: Application,
  getScene: () => SceneState,
  machines: MachineLayer,
  belts: BeltLayer,
  items: ItemLayer,
  // The overhead electrical wire layer (WUI-01): drawn with the SAME effectiveClock
  // as belts/items so its request/reply pulse freezes on pause / reduced-motion for
  // free (no new freeze gate). Composed above machines / below the overlay by
  // pixiApp; here it is simply driven each frame off the shared clock.
  wires: WireLayer,
  // The minimal overlay heartbeat: per-frame alert-ring pulse + TTL expiry
  // runs on the same wall clock as the other layer animations (21-02). The
  // optional second argument is the SAFE-02 motion flag (D-25) — the overlay
  // holds its two sinusoid alphas when it is true and keeps every elapsed /
  // TTL / decay computation on the advancing `nowMs` either way.
  overlay: { tick(nowMs: number, motionFrozen?: boolean): void },
): RenderLoop {
  let clock = 0;
  // MOTION-04 pinned render clock — inert (null) in production. When set, it
  // OVERRIDES the frame every sim-clock consumer derives, so a probe can freeze a
  // deterministic frame; it never touches the raw `clock` (renderClock() semantics
  // are preserved) and never writes scene/command/log (threat T-26-01).
  let pinnedClock: number | null = null;
  // SAFE-02 second gate — the overlay motion flag (independent of pinnedClock).
  // It is passed THROUGH to overlay.tick as its second argument; the `nowMs` the
  // overlay receives keeps advancing in both states. The overlay holds its two
  // sinusoid alphas at their seeded mid-band values while it is true, which is
  // what quiets the pulse under prefers-reduced-motion. Inert (false) in
  // production; it never touches clock/effectiveClock or the layer draws.
  let overlayPinned = false;
  // SLOT-04 trailing item interpolation - OFF by default, so the shipped draw is
  // byte-identical to the pre-Phase-62 one. Same production-inert model as
  // `pinnedClock`: a render-side boolean and nothing else (see setItemInterpolation).
  let itemInterpolation = ITEM_INTERPOLATION_DEFAULT;
  // SLOT-03 pre-Phase-62 tread appearance - NULL by default, so every shipped build
  // paints the wire-derived rate and this seam contributes nothing. Same
  // production-inert model as `pinnedClock`: a render-side number and nothing else, and
  // deliberately WITHOUT a figure of its own (see setTreadAppearanceOverride).
  let treadAppearanceOverride: number | null = null;
  let seeded = false;

  const tick = (): void => {
    const scene = getScene();
    const deltaMs = app.ticker.deltaMS;
    if (!seeded) {
      // Seed the clock from the first real packet so we never crawl up from 0
      // while the sim is already thousands of ticks ahead.
      if (scene.tick > 0) {
        clock = Math.max(0, scene.tick - LAG_TICKS);
        seeded = true;
      }
    } else if (scene.tick - clock > RESYNC_GAP_TICKS) {
      clock = scene.tick - LAG_TICKS; // snap forward to track the live sim
    } else {
      clock = advanceRenderClock(clock, scene.tick, deltaMs, SIM_TICK_MS);
    }
    const nowMs = performance.now();
    // MOTION-04: the EFFECTIVE clock is the pin when set, else the live clock. It
    // feeds every sim-clock consumer (machines/belts/items) so a pinned probe sees
    // one deterministic frame. The raw `clock` above is untouched.
    const effectiveClock = pinnedClock ?? clock;
    // MOTION-01/02: machines AND belts animate off the SAME render clock
    // (deterministic, replayable), NOT the wall clock, so both freeze together when
    // the sim pauses because `clock` stops advancing. They read that one clock at
    // DIFFERENT rates as of plan 61-04, which is the whole of the belts-at-60fps /
    // machines-at-10fps split: machines take the quantized MOTION-01 frame index
    // below, belts take `effectiveClock` itself. Only the overlay keeps a cosmetic
    // wall clock.
    //
    // TWO CLAIMS THAT STOOD HERE ARE FALSE AS OF PLAN 61-04 AND ARE CORRECTED IN
    // PLACE rather than deleted, so the change is legible to a reader who knew the
    // old model (the falsified-comment discipline `beltPainter.ts`, `items.ts` and
    // `belts.ts` all apply):
    //
    //   (a) *"The belt tread marches via this frame index (MOTION-02)"*. It does not.
    //       `belts.ts:338` records that `frame` "now selects nothing on the belt
    //       layer"; it survives on the signature only so a 2-argument caller keeps
    //       its exact meaning through the `frame * SIM_TICKS_PER_FRAME` default.
    //   (b) *"The shipped painter has quantum === SIM_TICKS_PER_FRAME (6) and
    //       therefore takes the `frame` branch and IGNORES this third argument, so
    //       passing it is byte-neutral for the default look"*. `SHIPPED_PAINTER`'s
    //       quantum is `BELT_MARCH_QUANTUM_TICKS` = 1 (`beltGeometry.ts`), so
    //       `belts.ts` passes the clock straight through and this third argument is
    //       now the ONLY march input. Taken at face value the old text would have a
    //       reader conclude the belt's pace cannot have moved, which is the opposite
    //       of what shipped.
    const frame = quantizedFrame(effectiveClock);
    machines.draw(scene, frame);
    // SLOT-03: the fourth argument is the pre-Phase-62 tread-appearance override, null
    // in every shipped build. Passed rather than read from a module global for the same
    // reason the item toggle is (below): it keeps the layer a pure function of its
    // arguments, so `belts.test.ts` drives both paths without installing a hook.
    belts.draw(scene, frame, effectiveClock, treadAppearanceOverride);
    // SLOT-04: the item layer takes the SAME effectiveClock as belts/wires, so a
    // pinned probe freezes the glide with everything else, plus the interpolation
    // toggle. Passing the toggle rather than reading a module global keeps the layer a
    // pure function of its arguments, which is what lets the exact-arc-length cases in
    // items.test.ts drive both paths without installing a hook.
    items.draw(scene, effectiveClock, itemInterpolation);
    // WUI-01: the overhead wire layer rides the SAME effectiveClock (its pulse is
    // render-only interpolation off the observed packet, so it freezes with the sim
    // when `clock` stops advancing — exactly like the belt tread). Idle wires emit
    // nothing (active-set), so a wire-free grid costs a single empty clear().
    //
    // The THIRD argument is the re-route mark's clock (plan 75-06, CABLE-07), and it is
    // the UNPINNED `clock`, never `effectiveClock`: reduced motion pins the effective
    // clock, and a mark that read it would sit on screen forever. The mark is a
    // time-limited affordance, which D-25 says keeps elapsing; only repeating pulses hold.
    wires.draw(scene, effectiveClock, clock);
    // The overlay alert-ring pulse is the ONE deliberate wall-clock exception: it
    // reads performance.now() and is NEVER routed through effectiveClock, so the
    // ring keeps pulsing even while the sim (and a pinned probe) hold a frozen frame.
    // SAFE-02: that is exactly why it needs its OWN gate — but the gate is a FLAG,
    // not a substituted timestamp (D-25). The overlay always receives the advancing
    // wall clock, so its 180ms reject-flash decay and 5000ms alert settle keep running
    // under reduced motion; what `overlayPinned` stops is the pulse (freezing
    // pinClock alone would leave that pulse animating, Pitfall 2).
    overlay.tick(nowMs, overlayPinned);
  };

  app.ticker.add(tick);

  return {
    renderClock: (): number => clock,
    frame: (): number => quantizedFrame(pinnedClock ?? clock),
    pinClock: (n: number | null): void => {
      pinnedClock = n;
    },
    pinOverlay: (frozen: boolean): void => {
      // A flag assignment and nothing else. There is deliberately no captured
      // timestamp: the overlay's own show-functions seed the mid-band pulse value
      // the frozen arm holds, so there is no phase to preserve, and a captured
      // constant compared against App.tsx's live-stamped `alertBornMs` is exactly
      // the mismatch that made the alert TTL unreachable (D-25).
      overlayPinned = frozen;
    },
    setItemInterpolation: (on: boolean): void => {
      itemInterpolation = on;
    },
    setTreadAppearanceOverride: (pxPerTick: number | null): void => {
      treadAppearanceOverride = pxPerTick;
    },
    stop: (): void => {
      app.ticker.remove(tick);
    },
  };
}
