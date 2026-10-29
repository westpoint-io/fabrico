// portEditLatch.ts (CR-01) - the in-flight port-edit latch, as a PURE state
// machine so both of its directions can be proven in the node test env.
//
// ---------------------------------------------------------------------------
// THE INVARIANT
//
//   At most ONE port edit may be sent against any ONE observed port topology.
//
// That is the whole safety property, and it is worth stating in those terms
// rather than as "debounce the button", because the hazard is not speed.
// `RemovePort` addresses a port by its PACKET INDEX, and `command.rs:854-869`
// validates the index RANGE and nothing else - no role check, no dock check. So
// two `RemovePort{index:1}` commands sent against the same on-screen list are
// both accepted, and the second one splices whatever slid into slot 1 when the
// first folded (on a `[In@0, Out@1, Fault@2, Out@3]` Factory, that is the FAULT
// port - and `fold_remove_port` never touches `links`, so its belt is stranded
// on a port that no longer exists). The `AddPort` version appends two ports from
// one gesture and needs two Ctrl+Z, breaking the "one command = one host action
// = one undo step" contract.
//
// Conversely, once the topology on screen has CHANGED, the next index we would
// send is by definition addressed against fresh data, so the latch may open. The
// release condition is therefore not a heuristic: an observed topology change is
// the exact event that restores the invariant.
//
// ---------------------------------------------------------------------------
// WHY THERE IS NO TIMEOUT (the CR-01 iteration-2 correction)
//
// The previous shape armed a 1000 ms timer on every send and, when it fired,
// RELEASED the latch and told the user the host had rejected the edit. Elapsed
// time is not evidence of a rejection. The host routinely folds nothing for
// arbitrarily long:
//
//   * `SimLoop::step` skips `acquire_input()` entirely in
//     `RunState::Frozen` and deliberately HOLDS input in `RunState::Draining`.
//     Pause (the Toolbar button / Space) drives Draining -> Frozen, and the
//     gesture channel is unbounded - so an edit issued while paused is buffered
//     INDEFINITELY and folds only on Resume.
//   * A backgrounded window stops rAF, so the poll that observes the fold stops,
//     while `setTimeout` keeps firing.
//   * A long keyframe / load-swap, or a heavy Factory JS tick, stalls the fold.
//
// In every one of those the timer released the latch, accused the host of a
// rejection that never happened, and the user's obvious response - click again -
// queued the exact duplicate the latch exists to prevent. The failure mode was
// "releases too early", which is the dangerous direction.
//
// So the latch is DURABLE: it releases on the observed fold and on nothing else.
// The panel says what it actually knows ("waiting for the host") instead of
// guessing a verdict.
//
// PHASE 64 CHANGED THE PREMISE; PLAN 74.1-28 CHANGED THE BEHAVIOUR. The gesture
// channel DOES carry a verdict: the drain (`SimLoop::acquire_input` in
// `crates/fabrico-host/src/sim_loop.rs`) answers the gesture envelope's reply
// instead of discarding it, and a port edit rides App's `submitInput` like every
// other gesture, so a REFUSED one names its reason in the shared `#fab-refusal`
// surface. Two consequences, and they are different:
//
//   * A REFUSAL THAT NAMES THE LATCHED EDIT RELEASES IT (plan 74.1-28, re-walk G1,
//     closing WINDOWS row 72; a default the maintainers can overturn). A
//     refusal is proof the edit will never fold. Until this plan it released
//     nothing, because the panel could not tell which refusal was its own, and on
//     the walk a refused fourth output left the panel saying "The host has not
//     applied this yet." with `+ Add output` and every Disconnect greyed for 20 s
//     and more until an undo. The host's refusal frame now names the refused
//     command and its node (`GestureFrame::subject`, both transports), and
//     `refusalReleasesPortEdit` below releases ONLY a pending latch on that node
//     whose kind matches the named command (`AddPort` for an add, `RemovePort` for
//     a remove). Never by tag alone, never by timing (threat T-74.1-97). App runs
//     it BEFORE the display layer's stale-drop, so a dropped or repeated sentence
//     still releases.
//   * An ACCEPT still never releases it, and that one is structural: the reply
//     resolves in the DRAIN, one step ahead of the `tick_once` that folds the
//     enqueued edit and of the packet carrying the new port list. It means
//     "queued", never "folded". On both wires an accept writes nothing anyway.
//
// So the echo remains the only evidence that the state actually MOVED, and a named
// refusal the only evidence that it never will. The stalled readout and its
// [Try again] below stay for the case they exist for: an edit the host never
// answers at all.
//
// RESIDUAL, stated: the frontend does not count its own gestures, so a refusal is
// matched by command and node, not by sequence. A late refusal of an EARLIER edit
// of the same kind on the same node could release a newer latch. It needs that
// earlier edit to have been released without a fold or a refusal ([Try again] or a
// keyframe) and its refusal to arrive after the next press, which the drain's
// one-tick answer makes unreachable in practice.
//
// ---------------------------------------------------------------------------
// WHERE THE LATCH LIVES (the CR-01 iteration-3 correction)
//
// It used to live in a `useRef` inside the ConfigPanel instance, and App remounts
// that instance per selection (`key={selectedNode}`). Deselecting therefore
// DISCARDED the in-flight record while the edit was still sitting in the host's
// unbounded gesture channel, and the remounted panel offered the identical stale
// index again. That is three ordinary clicks - "click another machine, click back,
// click x again" - and while the sim is PAUSED it is worse than a perverse
// sequence, it is the only way the panel will accept a second port edit at all.
// The documented workaround for the liveness limit WAS the stranding path.
//
// So ownership now sits in App, in a `Map<node, PortEditLatch>` that outlives any
// panel instance, and the release is fed from App's ~10Hz poll rather than from a
// panel effect. Nothing in THIS file changed for that: the machine was already
// pure and React-free, which is exactly why only ownership had to move.
//
// ---------------------------------------------------------------------------
// WHY THERE IS A TICK, AND WHAT IT IS NOT (WR-01)
//
// A durable latch with no escape hatch is a dead end when the host never folds
// the edit at all, and there are at least three reachable ways for that to
// happen: a typed reject (`AddPort` -> `OutOfBounds` / `MachineTooBig` / `GrowBlocked`;
// until plan 88-02 the last two were `OutOfBounds` and `FootprintCollision`;
// command.rs:825-846, which a Factory reaches on its 4th Out at a grid edge or on
// a packed board), an `UnknownNode` / `NoSuchPort` arm (`Malformed` until 88-02; command.rs:794-804,
// 856-859), and - before this iteration - a send dropped on a null transport.
// (The last one is now closed at the source: App refuses to CLOSE the latch when
// there is no transport to send through, so a command that was never transmitted
// can no longer latch anything.)
//
// In the remaining cases the panel would sit on "Waiting for the host to apply
// this change." forever, with the whole Outputs group disabled, under copy that
// is not merely unhelpful but false - nothing is coming.
//
// `sentTick` bounds that wait in SIMULATED time, which is the one clock that
// carries information here:
//
//   * [CORRECTED IN PLACE BY PLAN 74.1-31; the bullet read "It does not advance at
//     all while the sim is paused or draining - so the paused case, which is the
//     whole reason the 1 s wall-clock timer was wrong, can never trip it. This is a
//     structural property, not a tuned constant."] HALF OF THAT WAS FALSE. A FROZEN
//     sim does not advance its tick, but Pause does not freeze at once: it enters
//     `RunState::Draining`, which keeps running `tick_body()` (up to
//     `MAX_SETTLE_TICKS`, 512) until belts and effects settle, while it HOLDS input.
//     So on a busy board the tick ran on for seconds after the Pause click with our
//     edit sitting unfolded in the channel, and after 30 of those drained ticks the
//     panel said "The host has not applied this yet." with [Try again]: the third
//     re-walk's PAUSED-READOUT, about 0.7 s after `+ Add output`, both walkers, and
//     only right after a Step (which freezes at once) did the paused wording stay.
//     Measured on the dev host: tick 66 -> 188 in the 3 s after Pause, stalled at
//     tick 100, 535 ms in. The structural property is restored by the caller saying
//     so: `isPortEditStale(..., paused)` ignores the forward arm while the client
//     believes the sim is paused, and `resumePortEdit` restarts the count at the
//     Resume tick, so drained ticks never count before OR after it.
//   * It advances only when the host is actually processing, which is precisely
//     when a fold of ours would have landed (once the sim is playing, see above).
//   * Crucially it is PACKET-DERIVED (`SceneState.tick` is filled from the render
//     stream). So it cannot advance while packets are stalled, backgrounded or
//     lost - i.e. it cannot advance while we would be BLIND to a fold that did
//     land. Every other clock available to the frontend keeps running through
//     exactly the outages that would make it lie. That is what makes "the sim ran
//     on 30 ticks and we never saw our fold" a sound observation rather than a
//     guess: a gesture in the channel is drained on the very next
//     `acquire_input`, so 30 OBSERVED ticks without it means it was drained and
//     rejected, not that it is still queued.
//
// And what it produces is NOT a verdict. Crossing the threshold does not release
// the latch and does not claim a rejection. It swaps the status for an explicit
// affordance ("The host has not applied this yet." + [Try again]) whose button
// the USER presses, against a topology they can see on screen. The panel still
// never infers anything it cannot observe; it just stops pretending the wait is
// bounded when it is not.

/** Which port edit is in flight. */
export type PortEditKind = 'add' | 'remove';

/** The minimum a port needs to expose to be ADDRESSED by a port edit. */
export interface PortAddress {
  /** The packet port index - what `RemovePort` splices. */
  index: number;
  /** The role byte - what slices the Out routing keyspace. */
  role: number;
}

export interface PortEditLatch {
  /**
   * The port ADDRESSING key the unacknowledged edit was sent against, or `null`
   * when no edit is in flight.
   */
  readonly sentPortsKey: string | null;
  /** Which edit is in flight. Only meaningful while `sentPortsKey !== null`. */
  readonly kind: PortEditKind;
  /**
   * The SIM TICK the edit was sent at (WR-01), or the tick the sim last RESUMED at
   * (`resumePortEdit`, plan 74.1-31). Only meaningful while `sentPortsKey !== null`.
   * Simulated time, never wall time - see the header: the count is ignored while the
   * client believes the host is paused (a pause drains with input held, so the tick
   * still moves), which is the property that makes it safe to bound the wait on.
   */
  readonly sentTick: number;
}

/** The idle latch - no edit in flight. */
export const IDLE_PORT_EDIT: PortEditLatch = { sentPortsKey: null, kind: 'add', sentTick: 0 };

/** Is an edit unacknowledged right now? */
/**
 * Close `next` on `node` and send the edit (phase 90 review IN-B-03): the close is undone, and the
 * latch put back as it was, when `send` reports it sent nothing (`submitInput` returns 0 on a
 * stopped sim or with no transport). A latch closed on an edit that never went on the wire waits for
 * a fold that cannot come. Returns whether the edit was sent.
 */
export function latchThenSend<K>(
  latches: Map<K, PortEditLatch>,
  node: K,
  next: PortEditLatch,
  send: () => number,
): boolean {
  const before = latches.get(node);
  latches.set(node, next);
  if (send() !== 0) return true;
  if (before === undefined) latches.delete(node);
  else latches.set(node, before);
  return false;
}

export function isPortEditPending(latch: PortEditLatch): boolean {
  return latch.sentPortsKey !== null;
}

/** The command name the host writes on a refusal of each port edit kind
 *  (`GestureFrame::subject` in `crates/fabrico-host/src/sim_loop.rs`). */
const REFUSED_CMD_OF: Readonly<Record<PortEditKind, string>> = { add: 'AddPort', remove: 'RemovePort' };

/**
 * Plan 74.1-28 (re-walk G1): does this host refusal end a pending port edit, and on
 * which node? Returns the node whose latch the refusal names, or `null`.
 *
 * A refusal ends a latch only when it names BOTH the node holding a pending latch and
 * the command that latch sent (`AddPort` for an add, `RemovePort` for a remove). A
 * refusal naming another node, another command, or nothing at all (an undecodable
 * frame) ends nothing: never by tag alone, never by timing (threat T-74.1-97).
 */
export function refusalReleasesPortEdit(
  latches: ReadonlyMap<number, PortEditLatch>,
  verdict: { cmd?: string; node?: number },
): number | null {
  if (verdict.node === undefined || verdict.cmd === undefined) return null;
  const latch = latches.get(verdict.node);
  if (latch === undefined || !isPortEditPending(latch)) return null;
  return REFUSED_CMD_OF[latch.kind] === verdict.cmd ? verdict.node : null;
}

/**
 * How many SIMULATED ticks a pending edit may go unfolded before the panel
 * offers the [Try again] escape (WR-01).
 *
 * 30 ticks is ~0.5 s at the 60 ticks/sec target - long enough that an ordinary
 * fold (which lands within a tick or two and is observed on the next ~10Hz poll)
 * never reaches it, short enough that a rejected edit does not strand the group
 * for a noticeable time. On a host running below target it stretches in wall
 * time with the sim, which is the correct behaviour: it is measuring the host's
 * own progress, not the user's patience.
 */
export const PORT_EDIT_STALL_TICKS = 30;

/**
 * Has a pending edit gone unfolded for long enough to offer the user a way out?
 *
 * This is NOT a release and NOT a verdict - see the header. It only decides
 * whether the panel shows the plain "waiting" status or the "not applied yet"
 * status WITH a [Try again] button; the latch itself stays closed either way
 * until the user explicitly presses it.
 *
 * A tick that has gone BACKWARDS counts as stale too: the only things that rewind
 * simulated time are a load / keyframe swap that replaced the timeline wholesale,
 * after which the index this edit was addressed against means nothing at all.
 */
export function isPortEditStale(
  latch: PortEditLatch,
  tick: number,
  after: number = PORT_EDIT_STALL_TICKS,
  paused: boolean = false,
): boolean {
  if (!isPortEditPending(latch)) return false;
  if (tick < latch.sentTick) return true;
  // Plan 74.1-31 (PAUSED-READOUT): a paused host drains with input HELD, so its ticks
  // are not ticks on which our fold could have landed. See the header.
  if (paused) return false;
  return tick - latch.sentTick >= after;
}

/**
 * Plan 74.1-31 (PAUSED-READOUT): the sim RESUMED at `tick`. The stall count of a
 * pending edit restarts here, because every tick before this one ran with input held
 * (a pause drains, see the header), so none of them is evidence the edit was refused.
 * Not a release: the latch stays closed against the same topology. An idle latch is
 * returned unchanged.
 */
export function resumePortEdit(latch: PortEditLatch, tick: number): PortEditLatch {
  if (!isPortEditPending(latch)) return latch;
  return { ...latch, sentTick: tick };
}

/**
 * The ADDRESSING key of a port list: `index,role` per port, in packet order.
 *
 * Deliberately NOT the geometric signature (`portsSignature`, which folds in
 * `side`/`cell_x`/`cell_y`). A pure re-seat moves every nub on screen without
 * changing what any index addresses, so it must NOT release the latch; equally,
 * an add or a remove ALWAYS changes this key, so a real fold always does.
 */
export function portsKeyOf(ports: readonly PortAddress[]): string {
  return ports.map((p) => `${p.index},${p.role}`).join('|');
}

/**
 * Close the latch against the topology now on screen.
 *
 * @returns the closed latch, or `null` when an edit is ALREADY unacknowledged -
 *          in which case the caller must send nothing. Returning null (rather
 *          than a boolean the caller may forget to read) is what puts the send
 *          structurally downstream of the guard: there is no closed latch to
 *          store unless the guard passed.
 */
export function beginPortEdit(
  latch: PortEditLatch,
  kind: PortEditKind,
  portsKey: string,
  sentTick: number,
): PortEditLatch | null {
  if (isPortEditPending(latch)) {
    return null;
  }
  return { sentPortsKey: portsKey, kind, sentTick };
}

/** Split an addressing key into its `index,role` entries (`''` -> no ports). */
function entriesOf(portsKey: string): string[] {
  return portsKey === '' ? [] : portsKey.split('|');
}

/** Shift an entry's INDEX field by `by`, leaving its role alone. */
function renumbered(entry: string, by: number): string {
  const comma = entry.indexOf(',');
  return `${Number(entry.slice(0, comma)) + by},${entry.slice(comma + 1)}`;
}

/**
 * Is `seen` exactly `sent` with ONE entry appended? That is what the panel's own
 * `AddPort` gesture produces: `fold_add_port` inserts at the record's `index`
 * (`tick.rs:573-604`, the insert at `:592`) and `reseat_ports` walks the list in
 * place without reordering it (`state.rs:1010`), so every existing index keeps
 * both its position and its role.
 *
 * THE LINE REFERENCE ABOVE WAS STALE AND IS CORRECTED HERE (73-03). It named a
 * range roughly 180 lines earlier in the file, and that was the THIRD distinct
 * value this one pointer has held. A pointer that has been wrong three times
 * teaches the next reader that all the pointers are approximate, so the FUNCTION
 * NAME is what to search for and the range is only ever a convenience. The stale
 * literal is deliberately not reproduced here: plan 73-03 asserts this file
 * contains zero occurrences of it, and a grep that a correction note can trip is
 * a guard the next reader stops believing.
 *
 * The fold is an INSERT rather than a push since 73-03, and that does NOT widen
 * what this predicate must accept. A forward `AddPort` - the only kind this
 * panel emits - resolves its `index` to the current list length at validate
 * time, so it still lands last and an append is still the only shape this
 * gesture can produce. A mid-list insert reaches the fold from exactly one
 * producer, the inverse of a `RemovePort`, which is an UNDO and never a panel
 * edit this latch is waiting on.
 */
function isAppendOf(sent: readonly string[], seen: readonly string[]): boolean {
  if (seen.length !== sent.length + 1) return false;
  for (let i = 0; i < sent.length; i += 1) {
    if (seen[i] !== sent[i]) return false;
  }
  return true;
}

/**
 * Is `seen` exactly `sent` with ONE entry spliced out and the tail renumbered
 * down by one? That is what a `RemovePort` fold produces - `fold_remove_port`
 * removes the port at `index` and the list closes up behind it, which is the
 * whole reason a duplicate removal is dangerous in the first place.
 *
 * Every splice point is tried because the panel does not need to know WHICH one
 * the host applied to know that what it is looking at is a removal of one port
 * from the list it sent against.
 */
function isSpliceOf(sent: readonly string[], seen: readonly string[]): boolean {
  if (seen.length !== sent.length - 1) return false;
  for (let k = 0; k < sent.length; k += 1) {
    let matches = true;
    for (let i = 0; i < seen.length; i += 1) {
      const expected = i < k ? sent[i] : renumbered(sent[i + 1], -1);
      if (seen[i] !== expected) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

/**
 * Feed the latch the topology the poll just observed.
 *
 * Releases IFF an edit is in flight AND the observed key is a valid SUCCESSOR of
 * the key it was sent against under the guarded operation - an append for an
 * `add`, a splice for a `remove`. Idempotent: observing the SAME key any number
 * of times, for any length of time, leaves the latch closed.
 *
 * WR-02: WHY A SUCCESSOR AND NOT MERELY "DIFFERENT".
 *
 * This used to release on any observed key change at all, under a header
 * claiming the release was causal rather than heuristic. It was causal only
 * under an unstated assumption: that the panel is the sole source of port
 * topology change. Undo/Redo breaks that, and both ride the same gesture
 * channel (App's `doUndo` / `doRedo`, through the one `submitInput` seam).
 *
 * The window: pause -> `Ctrl+Z` (queued) -> click `x` (the latch closes at K0,
 * `RemovePort` queued) -> Resume. `SimLoop::acquire_input` drains FIFO and BREAKS
 * immediately after an undo/redo, so the undo folds at tick N and our
 * `RemovePort` only at N+1. A ~10Hz poll landing in that ~16 ms
 * gap saw K1 != K0 and released the latch with our own edit still unacknowledged
 * - and a click then sent a second `RemovePort` against K1 with the first still
 * in flight. "Releases too early" is the direction that killed iteration 1.
 *
 * WHAT THIS DOES NOT FIX, stated plainly rather than left implied. The check is
 * over SHAPE, and shape is all the frontend has here. Since Phase 64 the gesture
 * channel carries a REFUSAL verdict, but still no acknowledgement that an
 * ACCEPTED edit has FOLDED - the reply resolves in the drain, one step ahead of
 * the fold - so it answers a different question. A fold that is
 * shape-INDISTINGUISHABLE
 * from ours still releases: an undo of a previous `AddPort` looks exactly like
 * our `remove` fold, and an undo of a previous `RemovePort` looks exactly like
 * our `add` fold. Those two cases survive, in the same ~16 ms window. The other
 * half of the race (undo-of-add against a pending add, undo-of-remove against a
 * pending remove, a rotate, a neighbouring machine's edit, a load) is now held.
 * Closing the rest needs a host ack, which is a protocol change this milestone
 * freezes.
 *
 * A stricter release means MORE ways to stay latched, which is precisely why the
 * WR-01 `[Try again]` escape had to exist before this landed: two folds arriving
 * between one poll and the next are no longer a successor of anything, and
 * without a recovery path that would be a dead end.
 *
 * ---------------------------------------------------------------------------
 * 73-08 / R-40: THE KEYFRAME ARM, AND WHY IT IS NOT A LOOSENING OF THE SHAPE
 * CHECK.
 *
 * The successor check above answers "did the list move the way OUR edit would
 * move it". There is one gesture where the answer is no and the latch must
 * release anyway, and it is the one the user actually performs: remove an
 * output, then press Ctrl+Z once.
 *
 * MEASURED, not inferred. The latch closes against K0. The `RemovePort` folds to
 * K1. The Ctrl+Z's index-carrying `AddPort` inverse (73-03, 73-06) folds
 * straight back to K0. The sim runs at 60 ticks per second and App polls at
 * about 10 Hz, so with high probability both folds land inside ONE poll window
 * and the panel never observes K1 at all. It observes K0, hits the
 * `sentPortsKey === portsKey` short-circuit below, and returns unchanged. THE
 * PANEL STICKS BECAUSE THE TWO FOLDS CANCEL - not because a mid-list insert is
 * not an append. Loosening `isAppendOf` to accept an insert would fix nothing
 * here and would re-open the releases-too-early failure that killed iteration 1
 * on a DIFFERENT gesture, so neither predicate body is touched.
 *
 * So the arm is keyed on the ONE fact that is causal rather than shape-inferred:
 * the packet's own `full` flag. A keyframe means the timeline was restructured
 * by something other than our edit - an undo, a redo, a load, a scene swap -
 * after which the packet index this edit was addressed against means nothing at
 * all, and holding a latch on the strength of it is a dead end with no cause the
 * user can see. That is the SAME principle `isPortEditStale` already states
 * above about a rewound tick; this generalises it from the clock to the packet,
 * and uses a flag every packet already carries rather than a host acknowledgement
 * the milestone freezes.
 *
 * IT SITS BEFORE THE IDENTITY SHORT-CIRCUIT DELIBERATELY. That short-circuit is
 * exactly what swallows the walked gesture, so an arm placed after it would be a
 * check that cannot fire.
 *
 * IT IS NOT A BLANKET RELEASE. It fires only on `full: true`. An ordinary diff
 * packet - which is every packet a live sim emits between restructures - still
 * goes through the successor check unchanged, and a pending `add` still holds
 * against somebody else's fold. `keyframe` defaults to `false` because that is
 * the SAFE direction: a caller that says nothing about the packet gets the old,
 * stricter behaviour and stays latched.
 *
 * @param keyframe whether the packet that produced `portsKey` carried
 *        `full: true`. Read off `RenderPacket.full`; never inferred from the
 *        key, the tick or elapsed time.
 * @returns the same object when nothing changed, so a caller can use identity to
 *          decide whether to touch React state.
 */
/**
 * Does this packet mean "the timeline was RESTRUCTURED", the one event that releases a
 * pending port edit latch (73-12, 73-REVIEW WR-01)?
 *
 * It exists as a named exported predicate rather than an inline `packet.full` at App's
 * packet handler for one reason: that line is inside a React effect that no unit test
 * reaches, and it is the line WR-01 found wrong. A predicate can be asserted directly.
 *
 * # `full` alone is TWO events and they mean opposite things here
 * - A RESTRUCTURE - an undo, a redo, a load, a New, a scene swap - re-writes the
 *   timeline. `RenderProducer` builds those with `resync: false`. After one, the packet
 *   index our edit was addressed against means nothing, and holding a latch is a dead end
 *   with no cause the user can see. RELEASE.
 * - A LAG RESYNC - both transports resend the CURRENT keyframe to a connection that fell
 *   past the bounded diff broadcast, with `resync: true`. The timeline did NOT move; the
 *   client simply missed frames, and our `RemovePort` may still be sitting unfolded in the
 *   host's gesture channel. Releasing here is the releases-too-early direction that killed
 *   this file's first iteration, and the user's obvious response - click again - queues the
 *   exact duplicate the latch exists to prevent. HOLD.
 *
 * The host sets `resync: true` ONLY when no `RenderProducer::reset` fell among the frames
 * the client missed (`RenderRelay::lagged` in `crates/fabrico-host/src/render_packet.rs`,
 * the plan 76-19 refuter round). A lag that spanned an undo, a redo, a load, a New or a
 * swap spanned a restructure, so its keyframe arrives with `resync: false` and this
 * predicate releases, exactly as the reset's own keyframe would have. Before that round
 * every lag was tagged, and the frontend cannot tell the two apart itself: a keyframe after
 * an undo of the latched edit, or one that puts another Factory with the same origin cell
 * and kind on the latched handle, can be byte-identical to one where nothing moved.
 *
 * A diff packet is neither and always returns false, which is the unchanged behaviour: the
 * successor check in {@link observePorts} is what decides a diff.
 */
export function isTimelineRestructure(packet: { full: boolean; resync: boolean }): boolean {
  return packet.full && !packet.resync;
}

export function observePorts(
  latch: PortEditLatch,
  portsKey: string,
  keyframe: boolean = false,
): PortEditLatch {
  if (!isPortEditPending(latch)) {
    return latch;
  }
  if (keyframe) {
    return IDLE_PORT_EDIT;
  }
  if (latch.sentPortsKey === portsKey) {
    return latch;
  }
  const sent = entriesOf(latch.sentPortsKey as string);
  const seen = entriesOf(portsKey);
  const folded = latch.kind === 'add' ? isAppendOf(sent, seen) : isSpliceOf(sent, seen);
  return folded ? IDLE_PORT_EDIT : latch;
}

/** What a latch's node is, structurally: its origin cell and kind (plan 76-19). */
export interface LatchSubject {
  readonly cell_x: number;
  readonly cell_y: number;
  readonly kind: number;
}

/**
 * Plan 76-19 (the handle-reuse audit's F2): the latched handles a `full` packet leaves
 * naming no machine the latch was about, given the scene's nodes just BEFORE and just AFTER
 * the packet was applied. A handle is dropped when it is gone, or when the node it names
 * now has another origin cell or kind than the node it named before.
 *
 * WHY. A `full` packet can remint every handle. A restructure keyframe also records release
 * evidence. Until the plan 76-19 refuter round a transport LAG RESYNC whose lag spanned a
 * `RenderProducer::reset` carried reminted handles with `resync: true`, which
 * {@link isTimelineRestructure} reads as no restructure, so no evidence was written, and
 * with only the poll's presence prune a latch on a handle that now named another machine
 * stayed pending.
 *
 * WHAT IT CANNOT SEE, and why it is no longer the fix. Origin cell and kind tell machines
 * apart only within one board. Across a reset another Factory can land on the latched
 * handle at the same origin cell (delete, place again, undo; or a New or Load that puts one
 * there), and the user's own edit can be undone inside the lag; both read here as the same
 * machine, so this keeps the latch. The refuters proved it, and the bytes give the frontend
 * nothing to tell those apart. The host now does: a lag that spanned a reset arrives as a
 * restructure (`resync: false`, see {@link isTimelineRestructure}), whose evidence releases
 * every latch. Within one handle generation the host never reuses a handle, so a
 * `resync: true` keyframe can no longer remint one. This function stays as a guard on the
 * `full` path; it is not what closes the hole.
 *
 * A latch whose machine kept its handle, cell and kind is kept: a lag resync with no reset
 * in it (73-12) still holds it.
 */
export function remintedLatchHandles(
  latched: Iterable<number>,
  before: ReadonlyMap<number, LatchSubject>,
  after: ReadonlyMap<number, LatchSubject>,
): number[] {
  const out: number[] = [];
  for (const h of latched) {
    const was = before.get(h);
    const now = after.get(h);
    if (
      now === undefined ||
      was === undefined ||
      now.cell_x !== was.cell_x ||
      now.cell_y !== was.cell_y ||
      now.kind !== was.kind
    ) {
      out.push(h);
    }
  }
  return out;
}
