import { describe, expect, it } from 'vitest';
import {
  IDLE_PORT_EDIT,
  latchThenSend,
  PORT_EDIT_STALL_TICKS,
  beginPortEdit,
  isPortEditPending,
  isPortEditStale,
  isTimelineRestructure,
  observePorts,
  portsKeyOf,
  refusalReleasesPortEdit,
  remintedLatchHandles,
  resumePortEdit,
  type PortAddress,
  type PortEditLatch,
} from './portEditLatch.ts';

// portEditLatch.test.ts (CR-01 + WR-05) - the latch's contract, BOTH directions.
//
// WR-05 filed the gap this file closes: the latch's SUCCESS path - an edit is
// sent, the host folds, the control comes back - had no test at any level, while
// the two tests that did exist (the mock e2e dblclick + timeout cases) both ran
// against a host that folds NOTHING. So a latch that released too early looked
// identical to a latch that worked, and a latch that never released at all
// looked identical too.
//
// Extracting the state machine out of ConfigPanel's hooks is what makes that
// testable here: the vitest env is `node` (no DOM, no testing-library - the
// repo's zero-new-packages discipline), so a hook-resident machine could only
// ever be exercised through Playwright.
//
// The two directions, stated as the properties they are:
//
//   DANGEROUS DIRECTION (releasing too early). No sequence of observations that
//   does NOT include a topology change may open the latch - not a thousand polls,
//   not any amount of elapsed time. This is the CR-01 regression: a paused sim
//   holds the gesture indefinitely (`SimLoop::step`), and the old 1 s timer
//   read that silence as a rejection, released, and invited the user to click
//   again - queueing the exact duplicate the latch exists to prevent.
//
//   ANNOYING DIRECTION (never releasing). An observed topology change MUST open
//   it, or the controls are dead until the panel remounts.

//   DEAD-END DIRECTION (never releasing, and no way out). New in iteration 3.
//   A durable latch that outlives the panel has no deselect/reselect escape left
//   (that escape WAS the CR-01 defect), so an edit the host never folds - a typed
//   `AddPort` reject, an `UnknownNode` arm - would disable the Outputs group
//   permanently. `isPortEditStale` is what makes the wait bounded, measured in
//   SIMULATED ticks so a paused host can never trip it.

const port = (index: number, role: number): PortAddress => ({ index, role });

/** An arbitrary non-zero sim tick to send at, so a test that forgets to advance
 *  the clock cannot pass by accident on a zero-vs-zero comparison. */
const SENT_TICK = 500;

/** A seeded Factory: `[In@0, Out@1, Fault@2]`. */
const SEEDED: PortAddress[] = [port(0, 0), port(1, 1), port(2, 2)];
/** The same Factory after one `+ Add output` - `fold_add_port` PUSHES. */
const POST_ADD: PortAddress[] = [...SEEDED, port(3, 1)];
/** ...and after removing Out ordinal 0 (packet index 1) from that. */
const POST_REMOVE: PortAddress[] = [port(0, 0), port(1, 2), port(2, 1)];

/** Close the latch against `ports`, asserting the slot was granted. */
function send(
  latch: PortEditLatch,
  kind: 'add' | 'remove',
  ports: PortAddress[],
  atTick = SENT_TICK,
): PortEditLatch {
  const next = beginPortEdit(latch, kind, portsKeyOf(ports), atTick);
  expect(next, 'the latch granted the send slot').not.toBeNull();
  return next as PortEditLatch;
}

describe('portsKeyOf - the ADDRESSING key, not the geometry', () => {
  it('keys on index+role only, so a pure RE-SEAT does not look like a fold', () => {
    // `reseat_ports` (state.rs:1010) rewrites `side`/`local_offset` in place and
    // reorders nothing. Every nub moves on screen; every index still addresses
    // the same port. Folding side/cell into the key would release the latch on a
    // rotate or a neighbour's add - i.e. on no fold of OURS at all.
    expect(portsKeyOf(SEEDED)).toBe(portsKeyOf(SEEDED.map((p) => ({ ...p }))));
  });

  it('CHANGES on an add and on a remove - the two folds that must release', () => {
    const seeded = portsKeyOf(SEEDED);
    expect(portsKeyOf(POST_ADD)).not.toBe(seeded);
    expect(portsKeyOf(POST_REMOVE)).not.toBe(seeded);
    expect(portsKeyOf(POST_REMOVE)).not.toBe(portsKeyOf(POST_ADD));
  });

  it('an EMPTY port list has a key too (a portless machine never throws)', () => {
    expect(portsKeyOf([])).toBe('');
    expect(isPortEditPending(observePorts(IDLE_PORT_EDIT, ''))).toBe(false);
  });
});

describe('the latch REFUSES a second send against the same topology', () => {
  it('grants the first send and denies the second, with no state change', () => {
    const closed = send(IDLE_PORT_EDIT, 'remove', SEEDED);
    expect(isPortEditPending(closed)).toBe(true);
    expect(beginPortEdit(closed, 'remove', portsKeyOf(SEEDED), SENT_TICK)).toBeNull();
  });

  it('denies a DIFFERENT kind too - the slot is per machine, not per button', () => {
    // An Add queued behind an unacknowledged Remove would fold against the
    // post-remove list, which is not the list the user was looking at.
    const closed = send(IDLE_PORT_EDIT, 'remove', SEEDED);
    expect(beginPortEdit(closed, 'add', portsKeyOf(SEEDED), SENT_TICK)).toBeNull();
  });

  it('denies a send even after the topology has been RE-OBSERVED unchanged many times', () => {
    // THE CR-01 REGRESSION, stated as a property. A paused/draining sim holds the
    // gesture in an unbounded channel, so the panel can poll the identical
    // topology arbitrarily many times. Every one of those observations is
    // evidence that nothing has folded - never evidence that nothing will.
    let latch = send(IDLE_PORT_EDIT, 'remove', SEEDED);
    for (let i = 0; i < 1000; i += 1) {
      latch = observePorts(latch, portsKeyOf(SEEDED));
    }
    expect(isPortEditPending(latch), 'the latch is DURABLE, not self-healing').toBe(true);
    expect(beginPortEdit(latch, 'remove', portsKeyOf(SEEDED), SENT_TICK)).toBeNull();
  });

  it('carries the kind of the edit in flight', () => {
    expect(send(IDLE_PORT_EDIT, 'add', SEEDED).kind).toBe('add');
    expect(send(IDLE_PORT_EDIT, 'remove', SEEDED).kind).toBe('remove');
  });
});

describe('the latch RELEASES on an observed fold - and only then', () => {
  it('opens when the topology changes, and grants the next send (the SUCCESS path)', () => {
    // WR-05: the half nothing covered. Send -> host folds -> the panel observes
    // the new list -> the control comes back -> a second, DIFFERENT edit is
    // allowed. A latch that stuck here would leave the machine uneditable until
    // the panel remounted, and no test anywhere would have noticed.
    const closed = send(IDLE_PORT_EDIT, 'add', SEEDED);
    const released = observePorts(closed, portsKeyOf(POST_ADD));
    expect(isPortEditPending(released), 'the observed fold opened the latch').toBe(false);
    expect(beginPortEdit(released, 'add', portsKeyOf(POST_ADD), SENT_TICK)).not.toBeNull();
  });

  it('releases on a REMOVE fold as well as an add', () => {
    const closed = send(IDLE_PORT_EDIT, 'remove', POST_ADD);
    expect(isPortEditPending(observePorts(closed, portsKeyOf(POST_REMOVE)))).toBe(false);
  });

  it('returns the SAME object when nothing changed, so the caller can skip a re-render', () => {
    const closed = send(IDLE_PORT_EDIT, 'add', SEEDED);
    expect(observePorts(closed, portsKeyOf(SEEDED))).toBe(closed);
    expect(observePorts(IDLE_PORT_EDIT, portsKeyOf(POST_ADD))).toBe(IDLE_PORT_EDIT);
  });

  it('survives a full send/fold/send/fold cycle without leaking state', () => {
    let latch: PortEditLatch = IDLE_PORT_EDIT;
    latch = send(latch, 'add', SEEDED);
    latch = observePorts(latch, portsKeyOf(POST_ADD));
    latch = send(latch, 'remove', POST_ADD);
    expect(beginPortEdit(latch, 'remove', portsKeyOf(POST_ADD), SENT_TICK)).toBeNull();
    latch = observePorts(latch, portsKeyOf(POST_REMOVE));
    expect(latch).toEqual(IDLE_PORT_EDIT);
  });

  it('an idle latch is never released by an observation, whatever it reports', () => {
    expect(observePorts(IDLE_PORT_EDIT, portsKeyOf(SEEDED))).toBe(IDLE_PORT_EDIT);
    expect(isPortEditPending(IDLE_PORT_EDIT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WR-02 - the release is a SUCCESSOR check, not "the key changed".
// ---------------------------------------------------------------------------
describe('observePorts holds the latch on a fold that is not OURS', () => {
  it('holds when the list SHRANK under a pending ADD (an undo folded first)', () => {
    // The concrete window: pause -> Ctrl+Z (queued) -> click + Add output (the
    // latch closes) -> Resume. `SimLoop::acquire_input` BREAKS immediately after
    // an undo/redo, so the undo folds a tick before our add
    // and the ~10Hz poll can land in the gap. Releasing there would hand out a
    // second send slot with our own AddPort still unacknowledged.
    const closed = send(IDLE_PORT_EDIT, 'add', POST_ADD);
    const undoOfAnAdd = portsKeyOf(SEEDED); // the previous add reversed
    expect(undoOfAnAdd).not.toBe(portsKeyOf(POST_ADD));
    expect(observePorts(closed, undoOfAnAdd), 'a shrink is not an append').toBe(closed);
  });

  it('holds when the list GREW under a pending REMOVE (an undo folded first)', () => {
    const closed = send(IDLE_PORT_EDIT, 'remove', SEEDED);
    expect(observePorts(closed, portsKeyOf(POST_ADD)), 'a growth is not a splice').toBe(closed);
  });

  it('holds when a ROLE changed in place - nothing the panel sent does that', () => {
    // Same length, same indices, a different port list. A "key changed" release
    // treated this as our fold; it cannot be.
    const relabelled: PortAddress[] = [port(0, 0), port(1, 2), port(2, 1)];
    const closed = send(IDLE_PORT_EDIT, 'add', SEEDED);
    expect(observePorts(closed, portsKeyOf(relabelled))).toBe(closed);
  });

  it('holds when TWO folds landed between polls - no single op explains it', () => {
    // Two appends is not one append. This is the case that makes WR-01's escape
    // load-bearing rather than decorative: a stricter release means more ways to
    // stay latched, so there has to be a way out that is not a deselect.
    const closed = send(IDLE_PORT_EDIT, 'add', SEEDED);
    const twoAdded = portsKeyOf([...POST_ADD, port(4, 1)]);
    expect(observePorts(closed, twoAdded)).toBe(closed);
    // ...and the escape is offered for it once the sim has visibly moved on.
    expect(isPortEditStale(closed, SENT_TICK + PORT_EDIT_STALL_TICKS)).toBe(true);
  });

  it('still releases on the REAL fold shapes, both directions', () => {
    // The liveness half. A stricter release that also refused the genuine fold
    // would be a worse bug than the one it fixes.
    const add = send(IDLE_PORT_EDIT, 'add', SEEDED);
    expect(observePorts(add, portsKeyOf(POST_ADD))).toBe(IDLE_PORT_EDIT);

    const remove = send(IDLE_PORT_EDIT, 'remove', POST_ADD);
    expect(observePorts(remove, portsKeyOf(POST_REMOVE))).toBe(IDLE_PORT_EDIT);
  });

  it('releases on a splice at ANY position, including the last and the first', () => {
    // The panel does not know which index the host applied - only that what it is
    // looking at is one port fewer, closed up. Both ends are covered because an
    // off-by-one in the renumber walk would show at exactly one of them.
    const removeFirst: PortAddress[] = [port(0, 1), port(1, 2), port(2, 1)]; // In@0 gone
    const removeLast: PortAddress[] = [port(0, 0), port(1, 1), port(2, 2)]; // Out@3 gone
    for (const seen of [removeFirst, removeLast]) {
      const closed = send(IDLE_PORT_EDIT, 'remove', POST_ADD);
      expect(observePorts(closed, portsKeyOf(seen))).toBe(IDLE_PORT_EDIT);
    }
  });

  it('records the honest residual: a shape-identical undo is still indistinguishable', () => {
    // Stated as a test rather than left as a comment, because it is a real
    // remaining hole and the phase asserted the invariant was exact. An undo of a
    // PREVIOUS AddPort removes the pushed tail entry - which is a valid splice of
    // the list we sent a `remove` against, so it releases. Shape is all the
    // frontend has here: Phase 64 gave the gesture channel a REFUSAL verdict, but
    // still no acknowledgement that an ACCEPTED edit has FOLDED (the reply
    // resolves in the drain, one step ahead of the fold), so it cannot settle this
    // case. A real fold ack is a protocol change this milestone freezes.
    const closed = send(IDLE_PORT_EDIT, 'remove', POST_ADD);
    const undoOfThePreviousAdd = portsKeyOf(SEEDED);
    expect(
      observePorts(closed, undoOfThePreviousAdd),
      'documented residual, not an accident',
    ).toBe(IDLE_PORT_EDIT);
  });
});

// ---------------------------------------------------------------------------
// 73-08 / R-40 - the KEYFRAME release arm.
//
// The walked gesture (UNDO-06 walk step 6): the panel closes the latch against
// K0 and sends a `RemovePort`; the fold takes the list to K1; the user presses
// Ctrl+Z once and the index-carrying `AddPort` inverse folds straight back to
// K0. Both folds land inside ONE ~100ms poll window, because the sim runs at 60
// ticks per second, so the panel never observes K1 at all. It observes K0, hits
// the identity short-circuit, and returns the latch unchanged. The panel sticks
// in flight because the two folds CANCEL - not because an insert is not an
// append, which is what D-04 predicted and which measurement did not find.
//
// The arm is CAUSAL, not shape-inferred: a `full: true` keyframe means the
// timeline was restructured by something other than our edit (undo, redo, load,
// scene swap), after which the packet index our edit was addressed against means
// nothing at all. It generalises the principle `isPortEditStale` already states
// in its own words about a rewound tick.
// ---------------------------------------------------------------------------
describe('observePorts releases on a keyframe, whatever the key looks like', () => {
  it('a_pending_remove_releases_when_a_keyframe_arrives_carrying_the_original_key', () => {
    // THE WALKED GESTURE. The remove folded and its undo folded back inside one
    // poll window, so the key on screen is byte-identical to the one we sent
    // against. Without the keyframe arm this hits the `sentPortsKey === portsKey`
    // short-circuit and the panel offers [Try again] for an edit that already
    // happened and was already undone.
    const closed = send(IDLE_PORT_EDIT, 'remove', SEEDED);
    const sameKeyOnAKeyframe = observePorts(closed, portsKeyOf(SEEDED), true);
    expect(isPortEditPending(sameKeyOnAKeyframe), 'the keyframe opened the latch').toBe(false);
    expect(sameKeyOnAKeyframe).toBe(IDLE_PORT_EDIT);
    // ...and the controls are live: the next edit is granted its slot.
    expect(beginPortEdit(sameKeyOnAKeyframe, 'remove', portsKeyOf(SEEDED), SENT_TICK)).not.toBeNull();
  });

  it('a_pending_add_still_does_not_release_on_somebody_elses_fold_without_a_keyframe', () => {
    // The row that stops the new arm being a blanket loosening. This is the WR-02
    // window exactly: an undo of a previous `AddPort` shrank the list under our
    // pending `add`, on an ORDINARY DIFF packet. A shrink is not an append, and no
    // keyframe says the timeline was replaced, so the latch holds.
    const closed = send(IDLE_PORT_EDIT, 'add', POST_ADD);
    expect(observePorts(closed, portsKeyOf(SEEDED), false), 'a shrink is not an append').toBe(
      closed,
    );
    expect(beginPortEdit(closed, 'add', portsKeyOf(SEEDED), SENT_TICK)).toBeNull();
  });

  it('the_shape_predicates_still_release_on_an_ordinary_diff_packet', () => {
    // The liveness half: the existing path is untouched. An ordinary append and an
    // ordinary splice still release with NO keyframe, so the arm added nothing the
    // common case depends on.
    const add = send(IDLE_PORT_EDIT, 'add', SEEDED);
    expect(observePorts(add, portsKeyOf(POST_ADD), false)).toBe(IDLE_PORT_EDIT);
    const remove = send(IDLE_PORT_EDIT, 'remove', POST_ADD);
    expect(observePorts(remove, portsKeyOf(POST_REMOVE), false)).toBe(IDLE_PORT_EDIT);
  });

  it('the_stall_escape_route_is_unchanged', () => {
    // This phase makes the escape UNNECESSARY on one gesture. It does not remove
    // it and it does not retune it: an edit nothing resolves still crosses the
    // same threshold at the same count and still gets its [Try again].
    expect(PORT_EDIT_STALL_TICKS).toBe(30);
    const closed = send(IDLE_PORT_EDIT, 'remove', SEEDED);
    expect(isPortEditStale(closed, SENT_TICK + PORT_EDIT_STALL_TICKS - 1)).toBe(false);
    expect(isPortEditStale(closed, SENT_TICK + PORT_EDIT_STALL_TICKS)).toBe(true);
    // ...and crossing it is still NOT a release.
    expect(isPortEditPending(closed)).toBe(true);
  });

  it('an idle latch is not disturbed by a keyframe either', () => {
    // A keyframe with nothing in flight is an ordinary board swap. Identity is
    // preserved so App's poll does not touch React state on every load.
    expect(observePorts(IDLE_PORT_EDIT, portsKeyOf(SEEDED), true)).toBe(IDLE_PORT_EDIT);
  });
});

// ---------------------------------------------------------------------------
// WR-01 - the bounded WAIT. Not a release, and not a verdict.
// ---------------------------------------------------------------------------
describe('isPortEditStale - offering a way out without inventing a rejection', () => {
  it('does NOT release the latch, however far the sim runs on', () => {
    // The load-bearing property, and the one that separates this from the 1 s
    // timer iteration 1 shipped and iteration 2 deleted. Crossing the threshold
    // changes what the panel SAYS and adds a button; the edit stays latched, so
    // the stale index still cannot be re-sent until the user acts.
    const closed = send(IDLE_PORT_EDIT, 'remove', SEEDED);
    const farFuture = SENT_TICK + PORT_EDIT_STALL_TICKS * 1000;
    expect(isPortEditStale(closed, farFuture)).toBe(true);
    expect(isPortEditPending(closed), 'staleness is not a release').toBe(true);
    expect(beginPortEdit(closed, 'remove', portsKeyOf(SEEDED), farFuture)).toBeNull();
  });

  it('is FALSE while the tick has not moved - a frozen host can never trip it', () => {
    // The structural reason this is safe where wall time was not. `SimLoop::step`
    // skips `acquire_input()` in RunState::Frozen, and a frozen sim does not advance
    // its tick - so an edit buffered across a coffee break reads as "waiting", not as
    // "stalled". CORRECTED IN PLACE BY PLAN 74.1-31: this comment also said Draining
    // could never trip it; a draining host HOLDS input but still ADVANCES its tick,
    // which is the walk's PAUSED-READOUT. That case is pinned by the 74.1-31 describe
    // below, through the `paused` argument.
    const closed = send(IDLE_PORT_EDIT, 'add', SEEDED);
    for (const tick of [SENT_TICK, SENT_TICK + 1, SENT_TICK + PORT_EDIT_STALL_TICKS - 1]) {
      expect(isPortEditStale(closed, tick), `tick ${tick} is inside the window`).toBe(false);
    }
    expect(isPortEditStale(closed, SENT_TICK + PORT_EDIT_STALL_TICKS)).toBe(true);
  });

  it('treats a REWOUND tick as stale - a load replaced the timeline this addressed', () => {
    // Simulated time only goes backwards when a keyframe/load swapped the whole
    // timeline out, after which the packet index this edit was addressed against
    // means nothing. Holding the latch on the strength of a tick from a session
    // that no longer exists would be a dead end with no cause the user can see.
    const closed = send(IDLE_PORT_EDIT, 'remove', SEEDED);
    expect(isPortEditStale(closed, SENT_TICK - 1)).toBe(true);
  });

  it('is never true for an idle latch, at any tick', () => {
    expect(isPortEditStale(IDLE_PORT_EDIT, 0)).toBe(false);
    expect(isPortEditStale(IDLE_PORT_EDIT, 10_000_000)).toBe(false);
  });

  it('records the tick the edit was SENT at, so the window starts at the send', () => {
    expect(send(IDLE_PORT_EDIT, 'add', SEEDED, 42).sentTick).toBe(42);
    // ...and a released latch carries the idle sentinel, not a stale timestamp.
    expect(observePorts(send(IDLE_PORT_EDIT, 'add', SEEDED, 42), portsKeyOf(POST_ADD))).toBe(
      IDLE_PORT_EDIT,
    );
  });
});

// ---------------------------------------------------------------------------
// Plan 74.1-31 (third re-walk PAUSED-READOUT): A PAUSED HOST DRAINS, AND ITS TICKS ARE
// NOT STALL TICKS.
//
// The walk saw "The host has not applied this yet." with [Try again] about 0.7 s after
// `+ Add output` on a paused board, both walkers. The live leg reproduced it on the dev
// host and measured why: the scene tick ran 66 -> 188 in the 3 s after the Pause click,
// and the stalled line first showed at tick 100, 535 ms in. Pause enters
// `RunState::Draining`, which keeps `tick_body()` running (up to `MAX_SETTLE_TICKS`) while
// it HOLDS input, so the FORWARD arm here counted 30 drained ticks of an edit the host was
// never going to fold before Resume. (The planned hypothesis, the BACKWARDS arm firing on
// mismatched tick sources, is killed: the tick moved forward, and App passes the same
// `sceneState.tick` it stores.)
// ---------------------------------------------------------------------------
describe('a paused port edit is never stale on drained ticks (plan 74.1-31, PAUSED-READOUT)', () => {
  it('paused: an add sent at tick 70 is NOT stale while the host drains to tick 188 (the walk)', () => {
    const closed = send(IDLE_PORT_EDIT, 'add', SEEDED, 70);
    for (const tick of [70, 99, 100, 140, 188, 70 + 512]) {
      expect(isPortEditStale(closed, tick, PORT_EDIT_STALL_TICKS, true), `paused at tick ${tick}`).toBe(false);
    }
  });

  it('playing: the same 30 ticks without the fold still offer the way out', () => {
    const closed = send(IDLE_PORT_EDIT, 'add', SEEDED, 70);
    expect(isPortEditStale(closed, 99, PORT_EDIT_STALL_TICKS, false)).toBe(false);
    expect(isPortEditStale(closed, 100, PORT_EDIT_STALL_TICKS, false)).toBe(true);
    // The default is playing, so every existing caller reads as before.
    expect(isPortEditStale(closed, 100)).toBe(true);
  });

  it('a REWOUND tick is stale whether paused or not (a Load replaced the timeline)', () => {
    const closed = send(IDLE_PORT_EDIT, 'remove', SEEDED, 70);
    expect(isPortEditStale(closed, 69, PORT_EDIT_STALL_TICKS, true)).toBe(true);
    expect(isPortEditStale(closed, 69, PORT_EDIT_STALL_TICKS, false)).toBe(true);
  });

  it('Resume restarts the count from the resume tick, so drained ticks never count after it', () => {
    const closed = send(IDLE_PORT_EDIT, 'add', SEEDED, 70);
    const resumed = resumePortEdit(closed, 188);
    expect(resumed.sentTick).toBe(188);
    expect(isPortEditPending(resumed), 'a resume is not a release').toBe(true);
    expect(resumed.sentPortsKey).toBe(closed.sentPortsKey);
    expect(isPortEditStale(resumed, 189, PORT_EDIT_STALL_TICKS, false)).toBe(false);
    expect(isPortEditStale(resumed, 188 + PORT_EDIT_STALL_TICKS, PORT_EDIT_STALL_TICKS, false)).toBe(true);
    // An idle latch is returned unchanged.
    expect(resumePortEdit(IDLE_PORT_EDIT, 188)).toBe(IDLE_PORT_EDIT);
  });
});

// ---------------------------------------------------------------------------
// 73-12 (73-REVIEW WR-01): `full` alone is TWO events, and only one of them
// releases a pending latch.
//
// The 73-08 arm keyed the release on `packet.full`. Both transports resend the
// CURRENT keyframe - `full: true` - to a connection that fell past the bounded
// diff broadcast (256 frames, `DIFF_CHANNEL_CAPACITY`), on which the timeline did NOT move and the pending
// `RemovePort` may still be sitting unfolded in the host's gesture channel. So the
// arm released too early on exactly the backgrounded-window case this file's own
// header cites as the reason the 1000 ms wall-clock timer had to go, and the user's
// obvious response - click again - queues the duplicate the latch exists to prevent.
//
// The host now says which of the two happened (`RenderPacket.resync`), and this is
// the predicate that asks. It is exported rather than inlined at App's packet
// handler because that line sits inside a React effect no unit test reaches, and it
// is the line WR-01 found wrong.
// ---------------------------------------------------------------------------
describe('isTimelineRestructure separates a restructure from a lag resync', () => {
  it('a_restructure_keyframe_releases', () => {
    // Every keyframe `RenderProducer` builds: an undo, a redo, a load, a New, a
    // scene swap, or a fresh subscription. `resync` is false on all of them.
    expect(isTimelineRestructure({ full: true, resync: false })).toBe(true);
  });

  it('a_lag_resync_keyframe_does_NOT_release', () => {
    // THE WR-01 ROW. Red before 73-12 in the only sense available to a unit test:
    // before the field existed this packet was indistinguishable from the one above,
    // so the arm fired on it and the latch opened with the edit still in flight.
    expect(isTimelineRestructure({ full: true, resync: true })).toBe(false);
  });

  it('an_ordinary_diff_packet_releases_nothing_either_way', () => {
    // The NEGATIVE CONTROL, declared as one. A diff is not a keyframe at all, so
    // both answers must be false and the successor check in `observePorts` is what
    // decides it. Without this row the predicate could be written as `!resync` and
    // the two rows above would still pass.
    expect(isTimelineRestructure({ full: false, resync: false })).toBe(false);
    expect(isTimelineRestructure({ full: false, resync: true })).toBe(false);
  });
});

describe('refusalReleasesPortEdit - a refusal naming the latched edit ends it (plan 74.1-28, G1)', () => {
  const add = beginPortEdit(IDLE_PORT_EDIT, 'add', '0,0|1,1', 10) as PortEditLatch;
  const remove = beginPortEdit(IDLE_PORT_EDIT, 'remove', '0,0|1,1', 10) as PortEditLatch;

  it('a refused AddPort naming the node with a pending add releases that node', () => {
    expect(refusalReleasesPortEdit(new Map([[7, add]]), { cmd: 'AddPort', node: 7 })).toBe(7);
  });

  it('a refused RemovePort naming the node with a pending remove releases that node', () => {
    expect(refusalReleasesPortEdit(new Map([[7, remove]]), { cmd: 'RemovePort', node: 7 })).toBe(7);
  });

  it.each([
    ['another node', { cmd: 'AddPort', node: 8 }],
    ['another command on this node', { cmd: 'Rotate', node: 7 }],
    ['the other port edit on this node', { cmd: 'RemovePort', node: 7 }],
    ['no node (a command naming none)', { cmd: 'AddPort' }],
    ['no command and no node (an undecodable frame)', {}],
  ])('a refusal naming %s releases nothing', (_label, verdict) => {
    expect(refusalReleasesPortEdit(new Map([[7, add]]), verdict)).toBeNull();
  });

  it('a refusal for a node holding no latch, or an idle one, releases nothing', () => {
    expect(refusalReleasesPortEdit(new Map(), { cmd: 'AddPort', node: 7 })).toBeNull();
    expect(refusalReleasesPortEdit(new Map([[7, IDLE_PORT_EDIT]]), { cmd: 'AddPort', node: 7 })).toBeNull();
  });
});

// ---- a latch across a keyframe that reminted its handle (plan 76-19) --------------------
//
// A `full` packet can hand a latched handle to another machine. A restructure keyframe
// (an Undo, a Redo, a Load, a New) also records release evidence, but a transport LAG
// RESYNC whose lag spanned a `RenderProducer::reset` carries reminted handles with
// `resync: true`, which `isTimelineRestructure` reads as no restructure, so no evidence is
// written. Before plan 76-19 the only other prune was presence (the poll drops a latch whose
// handle is gone), so a latch on a handle now naming another machine stayed pending and
// that machine's panel showed the wait and refused its port edits. The node a handle names
// is identified structurally by its origin cell and kind: no two nodes share an origin
// cell, a turn keeps the anchor, and a diff packet never moves a node to another handle.

describe('remintedLatchHandles (plan 76-19, a latch the keyframe handed to another machine)', () => {
  const factoryAt = (cx: number, cy: number) => ({ cell_x: cx, cell_y: cy, kind: 2 });

  it('a_latch_whose_handle_names_another_machine_after_a_keyframe_is_dropped', () => {
    // POSITIVE CONTROL, both directions of the prune it already had: a latch whose handle
    // still names the same Factory is kept, and one whose handle is gone is dropped.
    const before = new Map([[1, factoryAt(10, 8)]]);
    expect(
      remintedLatchHandles([1], before, new Map([[1, factoryAt(10, 8)]])),
      'POSITIVE CONTROL: the same Factory on handle 1 keeps its latch',
    ).toEqual([]);
    expect(
      remintedLatchHandles([1], before, new Map()),
      'POSITIVE CONTROL: handle 1 gone drops its latch',
    ).toEqual([1]);

    // The keyframe reminted handle 1 onto the OTHER Factory, at (20,8).
    expect(
      remintedLatchHandles([1], before, new Map([[1, factoryAt(20, 8)]])),
      'a latch whose handle now names another Factory is dropped',
    ).toEqual([1]);
    // ...or onto a node of another kind at the same origin cell (the first one gone).
    expect(
      remintedLatchHandles([1], before, new Map([[1, { cell_x: 10, cell_y: 8, kind: 7 }]])),
      'a latch whose handle now names a Sink is dropped',
    ).toEqual([1]);
  });
});

// Phase 90 review IN-B-03: the port-edit funnel closed its latch even when `submitInput` sent nothing
// (it returns 0 on a stopped sim or with no transport), so the panel then waited for a fold that
// could never come. The close is undone when the send did not happen.
describe('latchThenSend - a latch is closed only for an edit that went on the wire (review IN-B-03)', () => {
  const closed: PortEditLatch = { sentPortsKey: '1:0', kind: 'add', sentTick: 5 };

  it('a_send_that_sent_nothing_leaves_the_latch_as_it_was', () => {
    const latches = new Map<number, PortEditLatch>();
    expect(latchThenSend(latches, 7, closed, () => 0), 'nothing sent').toBe(false);
    expect(latches.has(7), 'no latch is left waiting for a fold that cannot come').toBe(false);
    const before: PortEditLatch = { sentPortsKey: null, kind: 'remove', sentTick: 2 };
    latches.set(7, before);
    expect(latchThenSend(latches, 7, closed, () => 0)).toBe(false);
    expect(latches.get(7), 'an earlier latch value is put back').toBe(before);
  });

  it('a_send_that_went_out_closes_the_latch', () => {
    const latches = new Map<number, PortEditLatch>();
    expect(latchThenSend(latches, 7, closed, () => 12)).toBe(true);
    expect(latches.get(7)).toBe(closed);
  });
});
