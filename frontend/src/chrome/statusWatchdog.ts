// statusWatchdog.ts - the SAFE-01 playing-gated render-stream stall watchdog.
//
// A pure, testable module (mirroring statusMachine.ts's injectable-deps style)
// that owns the stall logic and NOTHING else: no React, no DOM, no App state. It
// watches the packet cadence at the transport ingress and, if the stream stalls
// WHILE PLAYING, fires a single onDisconnect; the first packet after a stall
// fires onReconnect so the caller can restore idle.
//
// THE KEYSTONE (threat T-34-DISCONNECT-FALSE, RESEARCH Pitfall 1): a PAUSED sim
// legitimately emits ZERO packets - render_packet.rs `on_tick` only sends while
// playing, so Playing is a guaranteed ~62.5 pkts/s heartbeat but Paused is silent
// by design. A naive "no packet in N ms => disconnected" watchdog would therefore
// fire "Disconnected" on every Pause. So EVERY arm is gated on `isPlaying()`: the
// watchdog only arms while playing and re-arms only while playing. The App
// disarms it on pause (clear) and re-arms on resume (arm).
//
// It performs NO scene/command/log write - it is read-only over the packet
// cadence (determinism boundary untouched, threat T-34-DET).

type RealTimerId = ReturnType<typeof setTimeout>;

/**
 * `TId` is the opaque timer-handle type: `ReturnType<typeof setTimeout>` in the
 * app, but a plain `number` under a fake clock in tests - so the seam stays
 * portable across host timer implementations (identical to StatusMachineDeps).
 */
export interface StatusWatchdogDeps<TId = RealTimerId> {
  /**
   * Read whether the sim is currently playing. THE GATE: a paused sim emits zero
   * packets by design, so the watchdog only ever arms while this returns true.
   * The App backs this with a ref so the callback reads a fresh value.
   */
  isPlaying: () => boolean;
  /** Fired ONCE when the stream stalls (threshold elapsed while playing). */
  onDisconnect: () => void;
  /** Fired ONCE when a packet arrives after a disconnect (the reconnect edge). */
  onReconnect: () => void;
  /** The stall threshold in ms (App discretion, ~750-1000ms). */
  thresholdMs: number;
  /** Injectable timer seam (default: real timers). Tests pass fakes. */
  setTimer?: (fn: () => void, ms: number) => TId;
  clearTimer?: (id: TId) => void;
}

export interface StatusWatchdog {
  /**
   * A packet arrived (the transport.onPacket hook): signal reconnect if we were
   * disconnected, then reset + re-arm the stall timer (only while playing).
   */
  onPacket: () => void;
  /**
   * Arm/re-arm the stall timer IFF playing (idempotent reset). Called on resume;
   * a no-op while paused (the gate). Any existing timer is cleared first.
   */
  arm: () => void;
  /** Disarm without firing (called on pause). Leaves the disconnected latch. */
  clear: () => void;
  /** True between a disconnect and the reconnecting packet (observability/test). */
  isDisconnected: () => boolean;
  /** Cancel the pending timer (mount cleanup - no leak across StrictMode boot). */
  dispose: () => void;
}

export function makeStatusWatchdog<TId = RealTimerId>(
  deps: StatusWatchdogDeps<TId>,
): StatusWatchdog {
  const setTimer =
    deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as TId);
  const clearTimer =
    deps.clearTimer ?? ((id: TId) => clearTimeout(id as unknown as RealTimerId));

  let timer: TId | undefined;
  // The stall latch: true from onDisconnect until the reconnecting packet. It
  // makes onDisconnect fire exactly once per stall and marks the reconnect edge.
  let disconnected = false;
  // WR-01: the stream has NOT started until the first packet arrives. The sim
  // boots playing, so the App arms the watchdog at mount - before the transport
  // exists and before a single frame is delivered. Arming then would start an
  // 800ms stall timer against a stream that never began and flash a false
  // "Disconnected" on any cold boot slower than the threshold (threat
  // T-34-DISCONNECT-FALSE). So `arm()` no-ops until the first `onPacket()` flips
  // this latch; the first real arm is done by that same `onPacket()`.
  let started = false;

  function clearTimerIfAny(): void {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
  }

  function arm(): void {
    // Reset any pending stall timer first (idempotent re-arm).
    clearTimerIfAny();
    // WR-01 GATE: never arm before the stream has started (the first packet). A
    // mount-time arm on a sim that boots playing would otherwise cry a false
    // "Disconnected" on a cold boot before a single frame arrives.
    if (!started) return;
    // THE GATE: never arm while paused - a paused sim's silence is expected, not
    // a fault (T-34-DISCONNECT-FALSE). Re-armed by the App on resume.
    if (!deps.isPlaying()) return;
    timer = setTimer(() => {
      timer = undefined;
      // IN-01 (defense-in-depth): re-check the gate at FIRE time. The paused-safety
      // guarantee otherwise rests entirely on the App calling clear() before the
      // threshold elapses; re-checking here means a pause landing between arm and
      // fire can never produce a false 'disconnected' even if the clear() were
      // missed or raced.
      if (!deps.isPlaying()) return;
      // Fire exactly once per stall (the latch guards a double-fire).
      if (!disconnected) {
        disconnected = true;
        deps.onDisconnect();
      }
    }, deps.thresholdMs);
  }

  function onPacket(): void {
    // WR-01: the first delivery marks the stream live, so `arm()` below (and every
    // later resume-driven arm) is now permitted. Before this, arm() is a no-op.
    started = true;
    // A packet after a stall is the reconnect signal - clear the latch and let
    // the caller restore idle. Fires exactly once per reconnect.
    if (disconnected) {
      disconnected = false;
      deps.onReconnect();
    }
    // Reset the stall timer (re-arm only while playing - the gate holds here too,
    // so a stray packet while paused cannot arm the timer).
    arm();
  }

  function clear(): void {
    clearTimerIfAny();
  }

  function isDisconnected(): boolean {
    return disconnected;
  }

  function dispose(): void {
    clearTimerIfAny();
  }

  return { onPacket, arm, clear, isDisconnected, dispose };
}

// ---------------------------------------------------------------------------
// THE HOST-WORK GATE (phase 90 review WR-B-02, walk todo 2026-10-24 "a Load on a running board
// flashes Disconnected during the swap").
//
// The host's sim thread sends nothing while it does a request's own work: `load_swap` builds the
// new board and its timer projection, `do_save` writes the file, New and an example install their
// board. On a playing board that silence crosses the watchdog's threshold (the plan 90-08 walk
// measured 1.4 s on the debug desktop build, so `Disconnected - live view frozen` and the dim showed
// for about 0.6 s over a Load that then succeeded). The watchdog still detects the stall; this gate
// decides what its `onDisconnect` writes:
//
//   - a Load in flight: nothing. The status machine's own cut-off (no packet for its window)
//     writes `Load failed`, and because the watchdog's latch stays set its auto-clear then
//     re-asserts `Disconnected`, so a dead host is still named, about 14 s later instead of 0.8 s.
//   - a Save, New or example the host is working on (`begin`): the check is deferred by `windowMs`
//     from the stall, and written then only if the stream is still down. The work is over when the
//     host speaks after the stall (`onReconnect`), when a New's or an example's swap keyframe
//     arrives (a timeline restructure: the swap is done), when `tickBudget` ticks have been seen
//     since `begin` (a Save's drain ends within the host's settle budget, and a write with no
//     stall at all ends here), or on `end` (a save failure, the stop).
//   - otherwise: written at once, as before.
// Pure over its injected deps, like the watchdog: no React, no DOM.
// ---------------------------------------------------------------------------

export interface HostWorkGateDeps<TId = RealTimerId> {
  /** The watchdog's stall latch (`isDisconnected`): read when a deferred check comes due. */
  isStreamDown: () => boolean;
  /** Whether a Load this page sent is in flight (the status machine's `isLoadInFlight`). */
  isLoadInFlight: () => boolean;
  /** Whether the simulation stopped (FAIL-01): then nothing is ever written. */
  isStopped: () => boolean;
  /** Write the stall status (`Disconnected - live view frozen`). */
  writeDisconnected: () => void;
  /** How long a host working on a Save, New or example may stay silent before it is named down. */
  windowMs: number;
  /** The ticks seen after `begin` past which the request is over. */
  tickBudget: number;
  setTimer?: (fn: () => void, ms: number) => TId;
  clearTimer?: (id: TId) => void;
}

export interface HostWorkGate {
  /**
   * A Save (`'save'`), or a New or an example (`'swap'`), was sent to a playing host: it may fall
   * silent doing it.
   */
  begin: (work: 'save' | 'swap') => void;
  /**
   * Every packet the page applies: counts the ticks the request has taken, and a `'swap'` request
   * ends on the first timeline-restructure keyframe (`restructure`, full and not a lag resync).
   */
  onPacket: (tick: number, restructure: boolean) => void;
  /** The first packet after a stall: the host is back, so its quiet work is done. */
  onReconnect: () => void;
  /** The host answered the request (a save failure) or the page stopped. */
  end: () => void;
  /** The watchdog fired: write the stall now, later, or not at all. */
  onStall: () => void;
  /** True between `begin` and the request's end. */
  isWorking: () => boolean;
  /**
   * True while a stall the gate deferred waits for its window: the status machine's auto-clear must
   * not re-assert `Disconnected` over it meanwhile (it reads the stream as down only when this is
   * false), or a Save's fading `Save requested` would show the stall the gate held back.
   */
  isHoldingStall: () => boolean;
  /** Cancel the deferred check (mount cleanup). */
  dispose: () => void;
}

export function makeHostWorkGate<TId = RealTimerId>(deps: HostWorkGateDeps<TId>): HostWorkGate {
  const setTimer =
    deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as TId);
  const clearTimer =
    deps.clearTimer ?? ((id: TId) => clearTimeout(id as unknown as RealTimerId));

  let working = false;
  let workIsSwap = false;
  let firstTick: number | null = null;
  let deferred: TId | undefined;

  function clearDeferred(): void {
    if (deferred !== undefined) {
      clearTimer(deferred);
      deferred = undefined;
    }
  }

  function begin(work: 'save' | 'swap'): void {
    working = true;
    workIsSwap = work === 'swap';
    firstTick = null;
  }

  function onPacket(tick: number, restructure: boolean): void {
    if (!working) return;
    if (workIsSwap && restructure) {
      working = false;
      return;
    }
    if (firstTick === null) firstTick = tick;
    else if (tick - firstTick > deps.tickBudget) working = false;
  }

  function onReconnect(): void {
    working = false;
    clearDeferred();
  }

  function end(): void {
    working = false;
    clearDeferred();
  }

  function onStall(): void {
    if (deps.isStopped()) return;
    if (deps.isLoadInFlight()) return;
    if (working) {
      if (deferred !== undefined) return;
      deferred = setTimer(() => {
        deferred = undefined;
        working = false;
        if (deps.isStopped() || deps.isLoadInFlight()) return;
        if (deps.isStreamDown()) deps.writeDisconnected();
      }, deps.windowMs);
      return;
    }
    deps.writeDisconnected();
  }

  function isWorking(): boolean {
    return working;
  }

  function isHoldingStall(): boolean {
    return deferred !== undefined;
  }

  return { begin, onPacket, onReconnect, end, onStall, isWorking, isHoldingStall, dispose: clearDeferred };
}
