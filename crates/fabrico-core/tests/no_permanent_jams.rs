//! Phase 87, "No permanent jams": the red-first probes for WINDOWS rows 165, 174, 175,
//! 176 and 177 (JAM-05, JAM-02, JAM-01, JAM-03 and JAM-04). Row 173 (JAM-06) is a host
//! reading and its probe lives in `fabrico-host` `render_packet.rs`
//! (`a_source_with_a_full_backlog_reads_backed_up`).
//!
//! THE RULE (87-CONTEXT D-01): every row dates from 2026-09-02 and ledgers assert stale
//! problems, so each row is measured again at the phase's own start revision before any
//! fix. Each probe below IS the test its plan turns on: it is committed `#[ignore]`d with
//! the plan that removes the ignore named in its reason, it was run with
//! `--include-ignored` at `PHASE87_START` and seen FAILED there (`87-EVIDENCE.md`
//! `## Red-first record`), and its plan removes the `#[ignore]` in the commit that makes
//! it pass. A probe is never loosened to pass; a probe that read green at the start would
//! have been a FIXED-ALREADY row and stopped its plan.
//!
//! Every probe prints its measured facts with `eprintln!` BEFORE it asserts, so a red run
//! carries the numbers the evidence records and a green run carries the numbers the fix
//! produced. The boards are the research's probe shapes (87-RESEARCH `## Summary`, P165,
//! P174, P175, P176b, P177B), rebuilt from public APIs that exist at `PHASE87_START`.
//!
//! The fault-nesting depth is an instrument of THIS FILE, never product code: a fault's
//! payload is decoded as a `Fault` again for as long as it decodes with reason
//! `OutputRefused`. Deciding "is this a fault" by decoding bytes is exactly what the
//! product must never do (87-RESEARCH Finding 3); a test reading its own board may.

mod common;

use common::{fire, grid_state_bytes, header};
use fabrico_core::command::{Command, Effect};
use fabrico_core::core::Core;
use fabrico_core::edit::{BeltEnd, DeletedSubgraph, EDIT_SCHEMA_VERSION, EditOp, EditRecord, MachineConfig};
use fabrico_core::event::{Event, EventPayload, SCHEMA_VERSION};
use fabrico_core::fault::{FAULT_PORT, Fault, FaultReason};
use fabrico_core::ids::{Item, NodeId, PortId};
use fabrico_core::snapshot;
use fabrico_core::state::{Axis, BeltTile, Medium, Node, Port, Role, Side, SinkTemplate, TileKind};

/// `SOURCE_PENDING_CAP`, read from the core rather than written again here.
const PENDING_CAP: usize = fabrico_core::admit::SOURCE_PENDING_CAP;
/// `MECHANICAL_INBOX_CAP`, likewise.
const INBOX_CAP: usize = fabrico_core::admit::MECHANICAL_INBOX_CAP;

/// The Source's backlog length (0 for any other kind).
fn pending(core: &Core, id: NodeId) -> usize {
    match core.state.node(id) {
        Some(Node::Source(s)) => s.pending.len(),
        _ => 0,
    }
}

/// Would the Source accept one more event (its backlog under the cap)?
fn source_would_accept(core: &Core, id: NodeId) -> bool {
    pending(core, id) < PENDING_CAP
}

/// Items resting on `port` of `id`'s inbox.
fn inbox_len(core: &Core, id: NodeId, port: u16) -> usize {
    core.state.inbox_of(id).map_or(0, |i| i.len_on(port))
}

/// Items on a belt's slots (0 for any other kind).
fn belt_items(core: &Core, id: NodeId) -> usize {
    match core.state.node(id) {
        Some(Node::Belt(b)) => b.slots.iter().filter(|s| s.is_some()).count(),
        _ => 0,
    }
}

/// The Debug effects a Sink `sink` emitted in `cmds`, as their message bytes.
fn sink_messages(cmds: &[Command], sink: NodeId) -> Vec<Vec<u8>> {
    cmds.iter()
        .filter(|c| c.id.1 == sink)
        .filter_map(|c| match &c.effect {
            Effect::Debug { message } => Some(message.clone()),
            _ => None,
        })
        .collect()
}

/// How deep a fault nests `OutputRefused` around its payload: 0 for an item that is not
/// an `OutputRefused` fault, 1 for one wrap, and so on. An instrument of this file.
fn refused_depth(item: &Item) -> usize {
    let mut depth = 0;
    let mut bytes = item.clone();
    while let Ok(f) = Fault::decode(&bytes) {
        if f.reason != FaultReason::OutputRefused {
            break;
        }
        depth += 1;
        bytes = Item(f.payload);
    }
    depth
}

/// Every `OutputRefused` fault resting on any node's `FAULT_PORT`: (count, deepest
/// nesting, largest resting fault's bytes). The public-read re-write of the
/// `output_refused_on_board` helper in `tick.rs` `mod tests`.
fn refused_census(core: &Core) -> (usize, usize, usize) {
    let mut count = 0;
    let mut deepest = 0;
    let mut largest = 0;
    for id in core.state.node_ids() {
        let Some(inbox) = core.state.inbox_of(id) else {
            continue;
        };
        for item in inbox.items_on(FAULT_PORT) {
            if Fault::decode(item).is_ok_and(|f| f.reason == FaultReason::OutputRefused) {
                count += 1;
                deepest = deepest.max(refused_depth(item));
                largest = largest.max(item.0.len());
            }
        }
    }
    (count, deepest, largest)
}

/// `OutputRefused` faults resting on ONE node's `FAULT_PORT`.
fn refused_on(core: &Core, id: NodeId) -> usize {
    core.state.inbox_of(id).map_or(0, |inbox| {
        inbox
            .items_on(FAULT_PORT)
            .filter(|item| Fault::decode(item).is_ok_and(|f| f.reason == FaultReason::OutputRefused))
            .count()
    })
}

/// A logged command timeout naming `node`, at `tick` and sequence `seq`.
fn timeout(node: NodeId, seq: u64, tick: u64) -> Event {
    Event {
        schema_version: SCHEMA_VERSION,
        partition: 0,
        sequence: seq,
        tick,
        payload: EventPayload::Timeout {
            command_id: (tick, node, 0),
        },
    }
}

/// WINDOWS 175, JAM-01 (P175): a Balancer drains BOTH declared In ports.
///
/// Leg A: one fed belt docked on the Balancer's In 1 only. Both Out Sinks must receive
/// items and In 1 must not sit at the cap. Leg B: a fed belt on each In, items tagged by
/// their Source; items from BOTH Sources must leave. At the research revision leg A read 0
/// and 0 out with In 1 at 16: nothing drains port 1.
#[test]
fn a_balancer_drains_both_inputs() {
    const TICKS: u64 = 400;

    // Leg A: Source -> belt(1) -> Balancer In 1; Balancer Out 0 and Out 1 -> two Sinks.
    let mut core = Core::genesis(header(0x87_0175));
    let s = core.state.add_source();
    let belt = core.state.add_belt(1);
    let bal = core.state.add_balancer(2);
    let sink0 = core.state.add_sink(SinkTemplate::Debug, 0);
    let sink1 = core.state.add_sink(SinkTemplate::Debug, 0);
    core.state.link((s, 0), (belt, 0));
    core.state.link((belt, 0), (bal, 1));
    core.state.link((bal, 0), (sink0, 0));
    core.state.link((bal, 1), (sink1, 0));
    let (mut out0, mut out1, mut seq) = (0usize, 0usize, 0u64);
    for _ in 0..TICKS {
        let t = core.tick;
        let evs = if source_would_accept(&core, s) {
            seq += 1;
            vec![fire(s, seq, t, Item(vec![0xA]))]
        } else {
            Vec::new()
        };
        let cmds = core.advance(&evs);
        out0 += sink_messages(&cmds, sink0).len();
        out1 += sink_messages(&cmds, sink1).len();
    }
    let in1 = inbox_len(&core, bal, 1);
    eprintln!(
        "P175 leg A ticks={TICKS} injected={seq} out0={out0} out1={out1} balancer_in1={in1} \
         belt_slots={} belt_staging={} source_pending={}",
        belt_items(&core, belt),
        inbox_len(&core, belt, 0),
        pending(&core, s),
    );

    // Leg B: Source A -> belt -> In 0, Source B -> belt -> In 1, items tagged A and B.
    let mut core = Core::genesis(header(0x87_1175));
    let sa = core.state.add_source();
    let sb = core.state.add_source();
    let ba = core.state.add_belt(1);
    let bb = core.state.add_belt(1);
    let bal_b = core.state.add_balancer(2);
    let k0 = core.state.add_sink(SinkTemplate::Debug, 0);
    let k1 = core.state.add_sink(SinkTemplate::Debug, 0);
    core.state.link((sa, 0), (ba, 0));
    core.state.link((sb, 0), (bb, 0));
    core.state.link((ba, 0), (bal_b, 0));
    core.state.link((bb, 0), (bal_b, 1));
    core.state.link((bal_b, 0), (k0, 0));
    core.state.link((bal_b, 1), (k1, 0));
    let (mut from_a, mut from_b, mut seq) = (0usize, 0usize, 0u64);
    for _ in 0..TICKS {
        let t = core.tick;
        let mut evs = Vec::new();
        if source_would_accept(&core, sa) {
            seq += 1;
            evs.push(fire(sa, seq, t, Item(vec![0xA])));
        }
        if source_would_accept(&core, sb) {
            seq += 1;
            evs.push(fire(sb, seq, t, Item(vec![0xB])));
        }
        let cmds = core.advance(&evs);
        for m in sink_messages(&cmds, k0).into_iter().chain(sink_messages(&cmds, k1)) {
            match m.as_slice() {
                [0xA] => from_a += 1,
                [0xB] => from_b += 1,
                _ => {}
            }
        }
    }
    eprintln!(
        "P175 leg B ticks={TICKS} left_from_in0={from_a} left_from_in1={from_b} \
         balancer_in0={} balancer_in1={}",
        inbox_len(&core, bal_b, 0),
        inbox_len(&core, bal_b, 1),
    );

    assert!(out0 > 0 && out1 > 0, "leg A: both Outs receive items from In 1 (out0={out0}, out1={out1})");
    assert!(in1 < INBOX_CAP, "leg A: In 1 does not sit at the cap (holds {in1})");
    assert!(from_a > 0 && from_b > 0, "leg B: items from both Sources leave (In 0 {from_a}, In 1 {from_b})");
}

/// WINDOWS 174, JAM-02 (P174): one slow Tee branch does not stop the healthy branch.
///
/// A Tee whose Out 1 belt's head docks nowhere and whose Out 0 feeds a Sink, fed every
/// 2 ticks while the Source accepts, for 800 ticks. The Sink must receive at least 90
/// items in every 200-tick window after the first (the feed is 100 a window). At the
/// research revision it read 20, 0, 0, 0: once the slow branch filled, the Tee stalled.
///
/// Plan 87-05 (D-03) turns it on and adds what the user reads beside the pace: the copies
/// the slow branch could not take are counted on `Tee.faults`, and the Tee is FAULTED on
/// every tick it sheds one.
#[test]
fn a_slow_tee_branch_does_not_stop_the_others() {
    const TICKS: u64 = 800;
    const WINDOW: u64 = 200;
    const FLOOR: usize = 90;

    let mut core = Core::genesis(header(0x87_0174));
    let s = core.state.add_source();
    let tee = core.state.add_tee(2);
    let sink = core.state.add_sink(SinkTemplate::Debug, 0);
    let slow = core.state.add_belt(1);
    core.state.link((s, 0), (tee, 0));
    core.state.link((tee, 0), (sink, 0));
    core.state.link((tee, 1), (slow, 0));
    let mut windows = vec![0usize; (TICKS / WINDOW) as usize];
    let mut seq = 0u64;
    let (mut shedding_ticks, mut shedding_unmarked) = (0usize, 0usize);
    for _ in 0..TICKS {
        let t = core.tick;
        let evs = if t.is_multiple_of(2) && source_would_accept(&core, s) {
            seq += 1;
            vec![fire(s, seq, t, Item(vec![1]))]
        } else {
            Vec::new()
        };
        let faults_before = tee_faults(&core, tee);
        let cmds = core.advance(&evs);
        windows[(t / WINDOW) as usize] += sink_messages(&cmds, sink).len();
        if tee_faults(&core, tee) > faults_before {
            shedding_ticks += 1;
            if !core.last_tick.faulted.contains(&tee) {
                shedding_unmarked += 1;
            }
        }
    }
    let faults = tee_faults(&core, tee);
    eprintln!(
        "P174 ticks={TICKS} injected={seq} healthy_per_{WINDOW}={windows:?} slow_belt_slots={} \
         slow_belt_staging={} tee_in={} source_pending={} tee_faults={faults} \
         shedding_ticks={shedding_ticks} shedding_ticks_not_faulted={shedding_unmarked}",
        belt_items(&core, slow),
        inbox_len(&core, slow, 0),
        inbox_len(&core, tee, 0),
        pending(&core, s),
    );

    for (k, n) in windows.iter().enumerate().skip(1) {
        assert!(
            *n >= FLOOR,
            "the healthy branch keeps its pace: window {k} received {n}, at least {FLOOR} required \
             (windows {windows:?})",
        );
    }
    assert!(faults > 0, "the copies the slow branch could not take are counted on Tee.faults");
    assert_eq!(
        shedding_unmarked, 0,
        "the Tee reads FAULTED on every tick it sheds a copy ({shedding_ticks} shedding ticks)"
    );
}

/// `Tee.faults` (0 for any other kind): the copies a busy branch could not take.
fn tee_faults(core: &Core, id: NodeId) -> u64 {
    match core.state.node(id) {
        Some(Node::Tee(t)) => t.faults,
        _ => 0,
    }
}

/// Take every item resting on a collector's In 0, so it never reaches the admission cap.
/// Returns how many it took. A collector is a `Source`, which ignores its input port.
fn drain_collector(core: &mut Core, id: NodeId) -> usize {
    let mut n = 0;
    while core.state.inbox_mut(id).take(0).is_some() {
        n += 1;
    }
    n
}

/// Pace `belt` at `ticks_per_slot` ticks per slot, the way the panel's pace field does.
fn pace_belt(core: &mut Core, belt: NodeId, ticks_per_slot: u32) {
    match core.state.node_mut(belt) {
        Some(Node::Belt(b)) => {
            b.ticks_per_slot = std::num::NonZeroU32::new(ticks_per_slot).expect("a pace is non-zero");
        }
        _ => panic!("pace_belt: not a belt"),
    }
}

/// Run a Source-fed board for `ticks`, firing `s` every 2 ticks while it accepts; `seq`
/// counts the events fired.
fn feed_every_two(core: &mut Core, s: NodeId, ticks: u64, seq: &mut u64) {
    for _ in 0..ticks {
        let t = core.tick;
        let evs = if t.is_multiple_of(2) && source_would_accept(core, s) {
            *seq += 1;
            vec![fire(s, *seq, t, Item(vec![1]))]
        } else {
            Vec::new()
        };
        core.advance(&evs);
    }
}

/// Plan 87-05, D-04: a Tee whose EVERY docked branch is full stalls, and sheds nothing.
///
/// Both Outs feed 1-tile belts whose heads dock nowhere. Once both belts and their
/// staging inboxes are full, no branch can take a copy, so the Tee is gated (the case
/// phase 71's gate already covers): it stops taking items, its inlet packs back to the
/// Source, and `Tee.faults` does not grow, because a gated Tee takes no item to copy.
#[test]
fn a_tee_with_every_branch_full_stalls() {
    let mut core = Core::genesis(header(0x87_2174));
    let s = core.state.add_source();
    let tee = core.state.add_tee(2);
    let a = core.state.add_belt(1);
    let b = core.state.add_belt(1);
    core.state.link((s, 0), (tee, 0));
    core.state.link((tee, 0), (a, 0));
    core.state.link((tee, 1), (b, 0));
    let mut seq = 0u64;
    feed_every_two(&mut core, s, 400, &mut seq);
    let at_400 = (tee_faults(&core, tee), inbox_len(&core, tee, 0), inbox_len(&core, a, 0), inbox_len(&core, b, 0));
    feed_every_two(&mut core, s, 400, &mut seq);
    let faults = tee_faults(&core, tee);
    eprintln!(
        "every-branch-full injected={seq} at_400(faults,tee_in,a_staging,b_staging)={at_400:?} \
         end: tee_faults={faults} tee_in={} source_pending={} a_slots={} a_staging={} b_slots={} b_staging={}",
        inbox_len(&core, tee, 0),
        pending(&core, s),
        belt_items(&core, a),
        inbox_len(&core, a, 0),
        belt_items(&core, b),
        inbox_len(&core, b, 0),
    );
    assert_eq!((at_400.2, at_400.3), (INBOX_CAP, INBOX_CAP), "both branches are full by tick 400");
    assert_eq!(faults, at_400.0, "a Tee with every branch full sheds nothing: Tee.faults does not grow");
    assert_eq!(inbox_len(&core, tee, 0), INBOX_CAP, "the gated Tee stops taking items: its inlet packs");
    assert_eq!(pending(&core, s), PENDING_CAP, "the jam packs back to the Source");
}

/// Plan 87-05, D-04, 87-RESEARCH Pitfall 4: an UNDOCKED branch is neither free nor busy.
///
/// Out 0 feeds a 1-tile belt whose head docks nowhere; Out 1 has no link at all (the
/// `77-one-board-all-five` leg 3 shape). Once Out 0 is full the Tee's only docked branch is
/// busy, so the Tee is gated and packs upstream. Were the undocked Out 1 counted as a free
/// branch, the Tee would never stall and would shed every copy Out 0 could not take.
#[test]
fn an_undocked_tee_branch_is_not_a_free_branch() {
    let mut core = Core::genesis(header(0x87_3174));
    let s = core.state.add_source();
    let tee = core.state.add_tee(2);
    let jammed = core.state.add_belt(1);
    core.state.link((s, 0), (tee, 0));
    core.state.link((tee, 0), (jammed, 0));
    let mut seq = 0u64;
    feed_every_two(&mut core, s, 800, &mut seq);
    let faults = tee_faults(&core, tee);
    eprintln!(
        "undocked-branch injected={seq} tee_faults={faults} tee_in={} source_pending={} \
         jammed_slots={} jammed_staging={}",
        inbox_len(&core, tee, 0),
        pending(&core, s),
        belt_items(&core, jammed),
        inbox_len(&core, jammed, 0),
    );
    assert_eq!(faults, 0, "no busy copies: the Tee stalls rather than shed, because Out 1 is not a free branch");
    assert_eq!(inbox_len(&core, tee, 0), INBOX_CAP, "the Tee is gated once Out 0 is full: its inlet packs");
    assert_eq!(pending(&core, s), PENDING_CAP, "the jam packs back to the Source");
}

/// Plan 87-05, D-04: a Tee with no docked branch is never gated (phase 71's rule, kept).
///
/// No Out is linked, so there is no destination to be full: every item the Source sends
/// is taken, its copies go to no link (a no-op at the drain), nothing packs and nothing
/// is counted as busy.
#[test]
fn a_tee_with_no_docked_branch_is_never_gated() {
    let mut core = Core::genesis(header(0x87_4174));
    let s = core.state.add_source();
    let tee = core.state.add_tee(2);
    core.state.link((s, 0), (tee, 0));
    let mut seq = 0u64;
    let mut deepest_inlet = 0usize;
    for _ in 0..800 {
        feed_every_two(&mut core, s, 1, &mut seq);
        deepest_inlet = deepest_inlet.max(inbox_len(&core, tee, 0));
    }
    let faults = tee_faults(&core, tee);
    eprintln!(
        "no-docked-branch injected={seq} tee_faults={faults} deepest_tee_in={deepest_inlet} \
         tee_in={} source_pending={}",
        inbox_len(&core, tee, 0),
        pending(&core, s),
    );
    assert_eq!(seq, 400, "the Source accepted every event: nothing packed back to it");
    assert!(deepest_inlet <= 1, "the Tee took every item as it came (deepest inlet {deepest_inlet})");
    assert_eq!((inbox_len(&core, tee, 0), pending(&core, s)), (0, 0), "nothing rests anywhere");
    assert_eq!(faults, 0, "an undocked branch is never busy");
}

/// Plan 87-05, D-03, threat T-87-13: no copy vanishes. On the P174 board, every copy the
/// Tee made is either delivered to (or resting on) the healthy branch, resting on the busy
/// branch, or counted on `Tee.faults`: their sum is twice the items the Tee took. The
/// count must be above 0, so the sum is not met by a Tee that never shed anything.
#[test]
fn a_tee_conserves_every_copy() {
    const TICKS: u64 = 800;
    let mut core = Core::genesis(header(0x87_5174));
    let s = core.state.add_source();
    let tee = core.state.add_tee(2);
    let sink = core.state.add_sink(SinkTemplate::Debug, 0);
    let slow = core.state.add_belt(1);
    core.state.link((s, 0), (tee, 0));
    core.state.link((tee, 0), (sink, 0));
    core.state.link((tee, 1), (slow, 0));
    let (mut seq, mut delivered) = (0u64, 0usize);
    for _ in 0..TICKS {
        let t = core.tick;
        let evs = if t.is_multiple_of(2) && source_would_accept(&core, s) {
            seq += 1;
            vec![fire(s, seq, t, Item(vec![1]))]
        } else {
            Vec::new()
        };
        let cmds = core.advance(&evs);
        delivered += sink_messages(&cmds, sink).len();
    }
    let taken = usize::try_from(seq).expect("fits") - pending(&core, s) - inbox_len(&core, tee, 0);
    let healthy = delivered + inbox_len(&core, sink, 0);
    let resting_busy = belt_items(&core, slow) + inbox_len(&core, slow, 0);
    let faults = usize::try_from(tee_faults(&core, tee)).expect("fits");
    eprintln!(
        "conservation injected={seq} taken={taken} healthy_delivered={delivered} healthy_resting={} \
         busy_resting={resting_busy} tee_faults={faults} tee_fault_port={}",
        inbox_len(&core, sink, 0),
        inbox_len(&core, tee, FAULT_PORT),
    );
    assert!(faults > 0, "the busy branch shed copies, so the sum below is not met vacuously");
    assert_eq!(
        healthy + resting_busy + faults,
        2 * taken,
        "every copy is delivered, resting or counted: {healthy} + {resting_busy} + {faults} \
         against 2 x {taken}"
    );
}

/// Plan 87-05, D-03 read per branch (87-RESEARCH A1): a branch takes its copy AT ONCE, on
/// the first Tee step that sees its slot free, and faults only while the slot is full.
///
/// "A branch whose hold is free takes its copy at once" is read as the branch's own
/// one-item demand in the gate, so this row holds it at the boundary, both ways. A Tee, Out
/// 0 into a collector, Out 1 into a 1-tile belt paced at 8 ticks per slot into a second
/// collector; both collectors are drained every tick so neither reaches the admission cap.
/// For every tick on which the Tee took an item (the healthy collector received one), the
/// slow branch's copy is delivered exactly when that belt's staging inbox ended the
/// previous tick below `MECHANICAL_INBOX_CAP`, and faults exactly when it ended it at the
/// cap. Both cases must be seen at least 50 times.
///
/// THE FOLD ORDER IT RELIES ON, measured: a Tee fed by a Source steps in the fixpoint's
/// SECOND pass (the Source's delivery wakes it with `wake_now`), after the slow belt has
/// stepped in the first pass and may have admitted an item off its staging inbox, so the
/// end of the previous tick is not what that Tee sees. This row therefore feeds the Tee
/// with a logged `Input` each tick (admitted before any node steps, plan 87-04's feed) and
/// builds the Tee before the belt, so the Tee steps first in the first pass and the staging
/// length it sees is the one the previous tick ended with. The two-way rule and both counts
/// are kept.
#[test]
fn a_tee_branch_takes_its_copy_the_tick_its_slot_frees() {
    const TICKS: u64 = 1200;
    const FROM: u64 = 400;
    const SLOW_PACE: u32 = 8;
    const AT_LEAST: usize = 50;

    let mut core = Core::genesis(header(0x87_6174));
    let tee = core.state.add_tee(2);
    let healthy = core.state.add_source();
    let slow = core.state.add_belt(1);
    let far = core.state.add_source();
    core.state.link((tee, 0), (healthy, 0));
    core.state.link((tee, 1), (slow, 0));
    core.state.link((slow, 0), (far, 0));
    pace_belt(&mut core, slow, SLOW_PACE);

    let mut seq = 0u64;
    let (mut free_cases, mut busy_cases, mut took_two) = (0usize, 0usize, 0usize);
    let mut wrong: Vec<(u64, usize, u64)> = Vec::new();
    let mut prev_staging = inbox_len(&core, slow, 0);
    let mut prev_faults = tee_faults(&core, tee);
    for _ in 0..TICKS {
        let t = core.tick;
        let evs = if inbox_len(&core, tee, 0) < INBOX_CAP {
            seq += 1;
            vec![input_to(tee, seq, t)]
        } else {
            Vec::new()
        };
        core.advance(&evs);
        let took = drain_collector(&mut core, healthy);
        drain_collector(&mut core, far);
        let staging = inbox_len(&core, slow, 0);
        let faults = tee_faults(&core, tee);
        let grew = faults - prev_faults;
        if t >= FROM {
            match took {
                0 => {}
                1 => {
                    let expected = u64::from(prev_staging >= INBOX_CAP);
                    if grew != expected {
                        wrong.push((t, prev_staging, grew));
                    } else if expected == 0 {
                        free_cases += 1;
                    } else {
                        busy_cases += 1;
                    }
                }
                _ => took_two += 1,
            }
        }
        prev_staging = staging;
        prev_faults = faults;
    }
    eprintln!(
        "slot-frees ticks={FROM}..{TICKS} pace={SLOW_PACE} fed={seq} delivered_when_free={free_cases} \
         faulted_when_full={busy_cases} ticks_taking_two={took_two} tee_faults={prev_faults} \
         wrong(first 8, as tick/prev_staging/faults_grew)={:?} wrong_total={}",
        &wrong[..wrong.len().min(8)],
        wrong.len(),
    );
    assert!(wrong.is_empty(), "the slow branch's copy follows the slot, both ways: {} ticks broke it", wrong.len());
    assert_eq!(took_two, 0, "the Tee took at most one item per tick");
    assert!(free_cases >= AT_LEAST, "a freed slot was seen taking its copy {free_cases} times");
    assert!(busy_cases >= AT_LEAST, "a full slot was seen faulting the copy {busy_cases} times");
}

/// The P176b board (87-RESEARCH `## Summary`, row 176): a Source into a Router with no
/// routes and no default (every item faults), the Router's fault port docked to a 1-tile
/// belt into a Sink. Returns `(core, source, router)`. Shared by the two JAM-03 tests so
/// they cannot drift onto different boards.
fn p176b_board() -> (Core, NodeId, NodeId) {
    let mut core = Core::genesis(header(0x87_0176));
    let s = core.state.add_source();
    let router = core.state.add_router(Vec::new(), None);
    let fault_belt = core.state.add_belt(1);
    let sink = core.state.add_sink(SinkTemplate::Debug, 0);
    core.state.link((s, 0), (router, 0));
    core.state.link((router, FAULT_PORT), (fault_belt, 0));
    core.state.link((fault_belt, 0), (sink, 0));
    (core, s, router)
}

/// Resting faults are seeded on the P176b Router by a logged command timeout every 5 ticks
/// before this tick.
const P176B_SEED_UNTIL: u64 = 400;

/// One P176b tick: the Source fed whenever it would accept, and a logged command timeout
/// on the Router every 5 ticks before `P176B_SEED_UNTIL` (the resting faults the drain arm
/// carries out).
fn p176b_tick(core: &mut Core, s: NodeId, router: NodeId, seq: &mut u64) {
    let t = core.tick;
    let mut evs = Vec::new();
    if source_would_accept(core, s) {
        *seq += 1;
        evs.push(fire(s, *seq, t, Item(vec![7])));
    }
    if t < P176B_SEED_UNTIL && t.is_multiple_of(5) {
        *seq += 1;
        evs.push(timeout(router, *seq, t));
    }
    core.advance(&evs);
}

/// Faults resting on a node's own `FAULT_PORT`, whatever their reason.
fn fault_backlog(core: &Core, id: NodeId) -> usize {
    inbox_len(core, id, FAULT_PORT)
}

/// WINDOWS 176, JAM-03 (P176b): the fault drain arm counts in the output gate, so the
/// fold's own drain never overfills a port and no refusal nests one fault inside another.
///
/// A Router with no routes and no default (every item faults) whose fault port docks a
/// 1-tile belt into a Sink, fed every tick, with a logged command timeout on the Router
/// every 5 ticks for the first 400 ticks (resting faults the drain arm carries out). Zero
/// `OutputRefused` faults may rest anywhere at every 100th tick to 4000, the largest
/// snapshot over ticks 2000 to 4000 may be no larger than the largest over 1000 to 2000,
/// and no fault may rest on the Router's fault port at those checks (added by plan 87-02:
/// once half 2 re-admits a refused fault unchanged, that backlog is the only reading that
/// still sees half 1 go missing).
/// At the research revision the nesting depth read 38, 69 and 131 at ticks 1000, 2000
/// and 3999, and the snapshot grew from 3379 to 12380 bytes.
#[test]
fn the_fault_drain_counts_in_the_gate() {
    const TICKS: u64 = 4000;

    let (mut core, s, router) = p176b_board();

    let mut seq = 0u64;
    let mut refused_at_checks: Vec<(u64, usize)> = Vec::new();
    let mut backlog_at_checks: Vec<(u64, usize)> = Vec::new();
    let mut facts: Vec<String> = Vec::new();
    let (mut max_early, mut max_late) = (0usize, 0usize);
    for _ in 0..TICKS {
        p176b_tick(&mut core, s, router, &mut seq);
        let now = core.tick;
        if now.is_multiple_of(100) {
            backlog_at_checks.push((now, fault_backlog(&core, router)));
            refused_at_checks.push((now, refused_census(&core).0));
        }
        if (1000..2000).contains(&now) {
            max_early = max_early.max(snapshot::snapshot(&core).len());
        } else if now >= 2000 {
            max_late = max_late.max(snapshot::snapshot(&core).len());
        }
        if now == 1000 || now == 2000 || now == 3999 {
            let (count, deepest, largest) = refused_census(&core);
            facts.push(format!(
                "tick={now} output_refused={count} deepest_nesting={deepest} largest_resting_fault_bytes={largest} \
                 snapshot_bytes={}",
                snapshot::snapshot(&core).len()
            ));
        }
    }
    let nonzero: Vec<_> = refused_at_checks.iter().filter(|(_, n)| *n > 0).collect();
    for f in &facts {
        eprintln!("P176b {f}");
    }
    eprintln!(
        "P176b ticks={TICKS} checks={} checks_with_output_refused={} max_snapshot_1000_2000={max_early} \
         max_snapshot_2000_4000={max_late}",
        refused_at_checks.len(),
        nonzero.len(),
    );
    eprintln!("P176b router_fault_backlog_at_checks={backlog_at_checks:?}");

    assert!(
        nonzero.is_empty(),
        "zero OutputRefused faults rest anywhere at every 100th tick; found at {} checks, first {:?}",
        nonzero.len(),
        nonzero.first(),
    );
    assert!(
        max_late <= max_early,
        "the save stops growing: the largest snapshot over 2000..4000 ({max_late}) is no larger than over \
         1000..2000 ({max_early})",
    );
    // THE DRAIN IS NOT DEFEATED BY ITS OWN REFUSALS, the reading that grades half 1 once
    // half 2 holds. Since plan 87-02 a refused item that left on `FAULT_PORT` is
    // re-admitted UNCHANGED, so with half 1 removed this board mints no `OutputRefused` at
    // all and the first assertion above cannot fail (measured: `b8702/mut-half1-trial.out`,
    // both JAM-03 tests green). What half 1 changes is whether the fault the drain arm
    // carries out is admitted: without it the Router steps with room for one, its own
    // no-match takes the slot, the drained fault is refused and comes straight back, and
    // the backlog never empties (measured: 15 then 16, `FAULT_QUEUE_CAP`, at every check,
    // `b8702/backlog-mut-half1.out`). With it the Router waits for room for two and every
    // seeded fault leaves (0 at every check, `b8702/backlog-real.out`).
    let stuck: Vec<_> = backlog_at_checks.iter().filter(|(_, n)| *n > 0).collect();
    assert!(
        stuck.is_empty(),
        "the fault drain empties the Router's backlog: no fault rests on its fault port at every 100th \
         tick; found at {} checks, first {:?}",
        stuck.len(),
        stuck.first(),
    );
}

/// WINDOWS 176 half 2, JAM-03 (D-05): a refused fault is never wrapped again, so no
/// resting fault anywhere on the P176b board nests more than one `OutputRefused` deep at
/// any 100th tick to 4000.
///
/// ON THE REAL TREE THIS PASSES BY CONSTRUCTION. Half 1 (the gate counts the drain arm)
/// makes a refusal on `FAULT_PORT` unreachable on THIS board (a Router emits one fault per
/// step), so nothing is refused and the depth is 0; a green run here says nothing about
/// half 2. It is kept as a regression guard for half 1. Half 2 is reachable on another
/// board since plan 87-04, a Factory's surplus faults, and
/// [`a_factorys_refused_surplus_faults_rest_unwrapped`] drives it end to end (87-REVIEW
/// WR-03); the unit test `tick::tests::tick_a_refused_fault_is_readmitted_unchanged` pins
/// both arms of `refused_dead_letter` on their own (`87-EVIDENCE.md` `## Plan 87-02`).
#[test]
fn a_refused_fault_is_not_wrapped_again() {
    const TICKS: u64 = 4000;
    let (mut core, s, router) = p176b_board();
    let mut seq = 0u64;
    let mut depths: Vec<(u64, usize)> = Vec::new();
    for _ in 0..TICKS {
        p176b_tick(&mut core, s, router, &mut seq);
        if core.tick.is_multiple_of(100) {
            depths.push((core.tick, refused_census(&core).1));
        }
    }
    let deepest = depths.iter().map(|(_, d)| *d).max().unwrap_or(0);
    let over: Vec<_> = depths.iter().filter(|(_, d)| *d > 1).collect();
    eprintln!(
        "P176b-half2 ticks={TICKS} checks={} deepest_nesting={deepest} checks_over_one={} \
         snapshot_bytes={}",
        depths.len(),
        over.len(),
        snapshot::snapshot(&core).len()
    );
    assert!(
        over.is_empty(),
        "no resting fault nests more than one OutputRefused deep; deeper at {} checks, first {:?}",
        over.len(),
        over.first(),
    );
}

/// WINDOWS 176 half 2, JAM-03 (D-05), on a board that really reaches it (87-REVIEW WR-03):
/// a Factory's surplus faults that the fault belt refuses are re-admitted onto the
/// Factory's own fault port UNCHANGED, never wrapped as `OutputRefused`.
///
/// Since plan 87-04 a run with emits past `FACTORY_EMITS_PER_PORT` pushes one
/// `FactoryError` per surplus emit onto `FAULT_PORT` in one step, while the gate clears
/// only the fault link's demand and the drain arm's. Here the JS emits 20 times on Out 0,
/// so every run pushes four faults at once. Out 0 runs to a collector that is emptied every
/// tick; the fault port docks a 1-tile belt paced 8 ticks per slot into a fault collector,
/// so the fault belt's staging inbox backs up and refuses part of each run's four. The
/// Source is fed every tick it accepts for 3000 ticks, then the board runs until it is still.
///
/// Read every tick: every fault resting on the Factory's fault port decodes as a
/// `FactoryError` from the Factory (never an `OutputRefused` around one), and at most
/// `FAULT_QUEUE_CAP` rest there. At least one fault must have rested there at some tick,
/// so the refusal arm was really taken. At the end every fault reaching the fault collector
/// is a `FactoryError`, the collector on Out 0 holds 16 per run, and the faults are
/// conserved: delivered + still resting + `Factory.faults` == 4 x runs.
///
/// Red when `refused_dead_letter` wraps a fault-port refusal again: the resting faults
/// then read `OutputRefused`.
#[test]
fn a_factorys_refused_surplus_faults_rest_unwrapped() {
    const FEED: u64 = 3000;
    const DRAIN_LIMIT: u64 = 20_000;
    const PACE: u32 = 8;
    const TWENTY_JS: &str =
        "export default function (input, ctx) { for (let i = 0; i < 20; i++) { ctx.emit(0, [input, i]); } }";
    let surplus = 20 - fabrico_core::factory::FACTORY_EMITS_PER_PORT;

    let mut core = Core::genesis(header(0x87_0176));
    let s = core.state.add_source();
    let f = core.state.add_factory(TWENTY_JS.to_owned(), fabrico_core::factory::DEFAULT_GAS_BUDGET, 7);
    let out = core.state.add_source();
    let fault_belt = core.state.add_belt(1);
    let fc = core.state.add_source();
    core.state.link((s, 0), (f, 0));
    core.state.link((f, 0), (out, 0));
    core.state.link((f, FAULT_PORT), (fault_belt, 0));
    core.state.link((fault_belt, 0), (fc, 0));
    pace_belt(&mut core, fault_belt, PACE);

    let (mut injected, mut seq) = (0u64, 0u64);
    let (mut out_delivered, mut faults_delivered) = (0u64, 0u64);
    let (mut max_resting, mut ticks_resting) = (0usize, 0u64);
    let mut not_factory_error: Vec<(u64, String)> = Vec::new();
    let mut still = 0u32;
    while core.tick < FEED + DRAIN_LIMIT {
        let t = core.tick;
        let evs = if t < FEED && source_would_accept(&core, s) {
            seq += 1;
            injected += 1;
            vec![fire(s, seq, t, Item(b"1".to_vec()))]
        } else {
            Vec::new()
        };
        core.advance(&evs);
        let resting: Vec<Item> =
            core.state.inbox_of(f).map_or(Vec::new(), |i| i.items_on(FAULT_PORT).cloned().collect());
        max_resting = max_resting.max(resting.len());
        if !resting.is_empty() {
            ticks_resting += 1;
        }
        for item in &resting {
            match Fault::decode(item) {
                Ok(x) if x.reason == FaultReason::FactoryError && x.source == f => {}
                other => not_factory_error.push((t, format!("{other:?}"))),
            }
        }
        while core.state.inbox_mut(out).take(0).is_some() {
            out_delivered += 1;
        }
        while let Some((_seq, item)) = core.state.inbox_mut(fc).take(0) {
            faults_delivered += 1;
            match Fault::decode(&item) {
                Ok(x) if x.reason == FaultReason::FactoryError && x.source == f => {}
                other => not_factory_error.push((t, format!("delivered {other:?}"))),
            }
        }
        let quiet = t >= FEED
            && pending(&core, s) == 0
            && queued(&core, f).is_empty()
            && resting.is_empty()
            && inbox_len(&core, f, 0) == 0
            && on_belt(&core, fault_belt) == 0;
        still = if quiet { still + 1 } else { 0 };
        if still >= 5 {
            break;
        }
    }
    let resting_end = inbox_len(&core, f, FAULT_PORT) as u64;
    let factory_faults = factory_faults(&core, f);
    let produced = surplus as u64 * injected;
    eprintln!(
        "P176-factory injected={injected} out_delivered={out_delivered} faults_produced={produced} \
         faults_delivered={faults_delivered} resting_end={resting_end} factory_faults={factory_faults} \
         max_resting={max_resting} ticks_with_resting={ticks_resting} not_factory_error={} first={:?} tick={}",
        not_factory_error.len(),
        not_factory_error.first(),
        core.tick,
    );

    assert!(injected > 50, "the Factory ran a real stream ({injected} runs)");
    assert!(max_resting > 0, "the fault belt refused part of a run's faults, so the refusal arm was taken");
    assert!(
        max_resting <= fabrico_core::admit::FAULT_QUEUE_CAP,
        "at most FAULT_QUEUE_CAP faults rest on the Factory ({max_resting})"
    );
    assert!(
        not_factory_error.is_empty(),
        "every resting and delivered fault is the Factory's own FactoryError, never wrapped: {} were not, first {:?}",
        not_factory_error.len(),
        not_factory_error.first(),
    );
    assert!(still >= 5, "the board goes still within {DRAIN_LIMIT} ticks of the feed ending");
    assert_eq!(out_delivered, 16 * injected, "Out 0 delivers the 16 emits within the cap of every run");
    assert_eq!(
        faults_delivered + resting_end + factory_faults,
        produced,
        "every surplus fault is delivered, resting or counted"
    );
}

/// WINDOWS 177, JAM-04 (P177B): a board jammed solid goes idle.
///
/// Source, belt, Tee, and two branch belts whose heads dock nowhere; 60 events in the
/// first ticks and none after. From tick 2000 to 30000 every tick must step zero nodes,
/// the snapshots at ticks 20000 and 30000 must have equal length and be byte-equal once
/// the second's tick is set to the first's, and `grid_state_bytes` must be identical.
/// Ticks 20000 and 30000 share one varint width (87-RESEARCH Pitfall 2). At the research
/// revision the board stepped 2.00 non-belt nodes and 3.00 belts every tick. Plan 87-06 put
/// the machines to sleep (0.00 non-belt steps) and plan 87-07 the settled belts, which turns
/// this probe on: a belt whose head cannot leave, whose items are packed from the head and
/// whose tail can admit nothing sleeps too, so the wake wheel is empty and the two saves
/// differ in the tick alone.
#[test]
fn a_board_jammed_solid_goes_idle() {
    const EVENTS: u64 = 60;
    const IDLE_FROM: u64 = 2000;
    const MEAN_UNTIL: u64 = 12_000;
    const SAVE_A: u64 = 20_000;
    const SAVE_B: u64 = 30_000;

    let mut core = Core::genesis(header(0x87_0177));
    let s = core.state.add_source();
    let feed = core.state.add_belt(1);
    let tee = core.state.add_tee(2);
    let left = core.state.add_belt(1);
    let right = core.state.add_belt(1);
    core.state.link((s, 0), (feed, 0));
    core.state.link((feed, 0), (tee, 0));
    core.state.link((tee, 0), (left, 0));
    core.state.link((tee, 1), (right, 0));

    let (mut non_belt_steps, mut belt_steps) = (0u64, 0u64);
    let mut busy_ticks = 0u64;
    let mut first_busy: Option<u64> = None;
    let mut save_a: Option<(Vec<u8>, Vec<u8>)> = None;
    while core.tick < SAVE_B {
        let t = core.tick;
        let evs = if t < EVENTS { vec![fire(s, t + 1, t, Item(vec![9]))] } else { Vec::new() };
        core.advance(&evs);
        let stepped = &core.last_tick.stepped;
        if t >= IDLE_FROM {
            if !stepped.is_empty() {
                busy_ticks += 1;
                first_busy.get_or_insert(t);
            }
            if t < MEAN_UNTIL {
                for id in stepped {
                    if matches!(core.state.node(*id), Some(Node::Belt(_))) {
                        belt_steps += 1;
                    } else {
                        non_belt_steps += 1;
                    }
                }
            }
        }
        if core.tick == SAVE_A {
            save_a = Some((snapshot::snapshot(&core), grid_state_bytes(&core)));
        }
    }
    let (snap_a, grid_a) = save_a.expect("tick 20000 was reached");
    let snap_b = snapshot::snapshot(&core);
    let grid_b = grid_state_bytes(&core);
    let mut rewound = core.clone();
    rewound.tick = SAVE_A;
    let snap_b_at_a = snapshot::snapshot(&rewound);
    let differing = snap_a.iter().zip(snap_b_at_a.iter()).filter(|(a, b)| a != b).count();
    // Means in hundredths, integer arithmetic only (no float in this crate, clippy's
    // disallowed-types rule).
    let span = MEAN_UNTIL - IDLE_FROM;
    let mean = |steps: u64| {
        let h = steps * 100 / span;
        format!("{}.{:02}", h / 100, h % 100)
    };
    eprintln!(
        "P177B mean_non_belt_steps_per_tick={} mean_belt_steps_per_tick={} (ticks {IDLE_FROM}..{MEAN_UNTIL}) \
         busy_ticks_{IDLE_FROM}_{SAVE_B}={busy_ticks} first_busy={first_busy:?} source_pending={} tee_in={}",
        mean(non_belt_steps),
        mean(belt_steps),
        pending(&core, s),
        inbox_len(&core, tee, 0),
    );
    eprintln!(
        "P177B snapshot_bytes_at_{SAVE_A}={} snapshot_bytes_at_{SAVE_B}={} bytes_differing_after_tick_rewind={differing} \
         grid_state_bytes_identical={}",
        snap_a.len(),
        snap_b.len(),
        grid_a == grid_b,
    );

    assert_eq!(busy_ticks, 0, "from tick {IDLE_FROM} to {SAVE_B} every tick steps zero nodes (first busy {first_busy:?})");
    assert_eq!(snap_a.len(), snap_b.len(), "the save stops growing: equal length at ticks {SAVE_A} and {SAVE_B}");
    assert_eq!(snap_a, snap_b_at_a, "the two saves differ only in the tick counter");
    assert_eq!(grid_a, grid_b, "grid_state_bytes is identical at ticks {SAVE_A} and {SAVE_B}");
}

/// The P177B board (87-RESEARCH `## Summary`): a Source, a 1-tile inlet belt, a Tee and
/// two 1-tile branch belts whose heads dock nowhere. Returns `(core, source, tee)`.
fn p177b_board(seed: u64) -> (Core, NodeId, NodeId) {
    let mut core = Core::genesis(header(seed));
    let s = core.state.add_source();
    let feed = core.state.add_belt(1);
    let tee = core.state.add_tee(2);
    let left = core.state.add_belt(1);
    let right = core.state.add_belt(1);
    core.state.link((s, 0), (feed, 0));
    core.state.link((feed, 0), (tee, 0));
    core.state.link((tee, 0), (left, 0));
    core.state.link((tee, 1), (right, 0));
    (core, s, tee)
}

/// Plan 87-06, JAM-04, D-06, WINDOWS 177 (P177B): a machine behind a blocked output sleeps.
///
/// The P177B board, 60 events in the first ticks and none after. Once the branches, the
/// inlet and the Tee are full, nothing can move. From tick 2000 to 12000 no node that is
/// not a belt may appear in `last_tick.stepped`, `grid_state_bytes` must be identical at
/// ticks 20000 and 30000 (one varint width, 87-RESEARCH Pitfall 2), and the scheduler's
/// sleep set must hold the Source and the Tee. The belts' own sleep is plan 87-07's, so
/// belt steps are printed and not asserted here; since that plan the set also holds the
/// three settled belts, so it is asserted to be every node on the board (the belts' own
/// steps are graded by `a_board_jammed_solid_goes_idle`). Before this plan the board
/// stepped 2.00 non-belt nodes per tick: the gate re-scheduled every blocked machine at
/// `now + 1` forever.
#[test]
fn a_board_jammed_solid_steps_no_machine() {
    const EVENTS: u64 = 60;
    const IDLE_FROM: u64 = 2000;
    const MEAN_UNTIL: u64 = 12_000;
    const SAVE_A: u64 = 20_000;
    const SAVE_B: u64 = 30_000;

    let (mut core, s, tee) = p177b_board(0x87_0177);
    let (mut non_belt_steps, mut belt_steps) = (0u64, 0u64);
    let mut grid_a: Option<Vec<u8>> = None;
    while core.tick < SAVE_B {
        let t = core.tick;
        let evs = if t < EVENTS { vec![fire(s, t + 1, t, Item(vec![9]))] } else { Vec::new() };
        core.advance(&evs);
        if (IDLE_FROM..MEAN_UNTIL).contains(&t) {
            for id in &core.last_tick.stepped {
                if matches!(core.state.node(*id), Some(Node::Belt(_))) {
                    belt_steps += 1;
                } else {
                    non_belt_steps += 1;
                }
            }
        }
        if core.tick == SAVE_A {
            grid_a = Some(grid_state_bytes(&core));
        }
    }
    let grid_a = grid_a.expect("tick 20000 was reached");
    let grid_b = grid_state_bytes(&core);
    let blocked: Vec<NodeId> = core.sched.blocked_ids().collect();
    // Since plan 87-07 the three settled belts sleep too, so the set is the whole board.
    let mut expected: Vec<NodeId> = core.state.node_ids().collect();
    expected.sort();
    let span = MEAN_UNTIL - IDLE_FROM;
    let mean = |steps: u64| {
        let h = steps * 100 / span;
        format!("{}.{:02}", h / 100, h % 100)
    };
    eprintln!(
        "P177B-SLEEP mean_non_belt_steps_per_tick={} mean_belt_steps_per_tick={} (ticks {IDLE_FROM}..{MEAN_UNTIL}) \
         grid_state_bytes_identical_{SAVE_A}_{SAVE_B}={} blocked={} source_pending={} tee_in={}",
        mean(non_belt_steps),
        mean(belt_steps),
        grid_a == grid_b,
        blocked.len(),
        pending(&core, s),
        inbox_len(&core, tee, 0),
    );

    assert_eq!(
        non_belt_steps, 0,
        "from tick {IDLE_FROM} to {MEAN_UNTIL} no machine steps on a board jammed solid"
    );
    assert_eq!(grid_a, grid_b, "grid_state_bytes is identical at ticks {SAVE_A} and {SAVE_B}");
    assert!(blocked.contains(&s) && blocked.contains(&tee), "the Source and the Tee are asleep behind their blocked outputs");
    assert_eq!(blocked, expected, "and since plan 87-07 the settled belts with them: every node sleeps");
    assert!(pending(&core, s) > 0, "the Source sleeps holding work (non-vacuity)");
    assert_eq!(inbox_len(&core, tee, 0), INBOX_CAP, "the Tee sleeps with a full inbox (non-vacuity)");
}

/// Plan 87-06, JAM-04, D-06: the belt that frees a slot wakes the machine it starved.
///
/// Source, 1-tile inlet belt, a one-Out Balancer, a 1-tile outlet belt paced at 8 ticks
/// per slot, and a collector (a Source, which ignores its input) drained every tick. The
/// Source is fed one tagged event per tick whenever it would accept one, for 3000 ticks,
/// then the board runs until every item is in. The Balancer is faster than its outlet, so
/// it spends the run asleep behind the outlet's full staging inbox. On every tick the
/// Balancer started asleep and the outlet took an item off its staging inbox, the
/// Balancer must step on the next tick (the consumer wake, at `now + 1`); it must step on
/// far fewer ticks than the window holds (it sleeps); and every item the Source took
/// reaches the collector, in order. Before this plan nothing ever entered the sleep set,
/// so the wake count read 0 and the Balancer stepped on every tick.
#[test]
fn a_slow_belt_wakes_the_machine_it_starved() {
    const FEED: u64 = 3000;
    const DRAIN_BUDGET: u64 = 20_000;
    const PACE: u32 = 8;

    let mut core = Core::genesis(header(0x87_0602));
    let s = core.state.add_source();
    let inlet = core.state.add_belt(1);
    let bal = core.state.add_balancer(1);
    let outlet = core.state.add_belt(1);
    let collector = core.state.add_source();
    core.state.link((s, 0), (inlet, 0));
    core.state.link((inlet, 0), (bal, 0));
    core.state.link((bal, 0), (outlet, 0));
    core.state.link((outlet, 0), (collector, 0));
    pace_belt(&mut core, outlet, PACE);

    let mut taken: Vec<Vec<u8>> = Vec::new();
    let mut arrived: Vec<Vec<u8>> = Vec::new();
    let mut seq = 0u64;
    let mut wake_due: Option<u64> = None;
    let (mut wakes_due, mut wakes_kept, mut wakes_missed) = (0u64, 0u64, 0u64);
    let (mut bal_step_ticks, mut window_ticks) = (0u64, 0u64);
    while core.tick < FEED + DRAIN_BUDGET {
        let t = core.tick;
        let feeding = t < FEED;
        let evs = if feeding && source_would_accept(&core, s) {
            seq += 1;
            let tag = seq.to_le_bytes().to_vec();
            taken.push(tag.clone());
            vec![fire(s, seq, t, Item(tag))]
        } else {
            Vec::new()
        };
        let asleep_before = core.sched.is_blocked(bal);
        let staging_before = inbox_len(&core, outlet, 0);
        core.advance(&evs);
        let stepped = core.last_tick.stepped.contains(&bal);
        if let Some(due) = wake_due.take() {
            assert_eq!(due, t, "a due wake is read on its own tick");
            if stepped {
                wakes_kept += 1;
            } else {
                wakes_missed += 1;
            }
        }
        if asleep_before && inbox_len(&core, outlet, 0) < staging_before {
            wakes_due += 1;
            wake_due = Some(t + 1);
        }
        if (200..FEED).contains(&t) {
            window_ticks += 1;
            if stepped {
                bal_step_ticks += 1;
            }
        }
        while let Some((_seq, item)) = core.state.inbox_mut(collector).take(0) {
            arrived.push(item.0);
        }
        if !feeding && arrived.len() == taken.len() {
            break;
        }
    }
    eprintln!(
        "SLOW-OUTLET taken={} arrived={} wakes_due={wakes_due} wakes_kept={wakes_kept} wakes_missed={wakes_missed} \
         balancer_step_ticks={bal_step_ticks} of {window_ticks} (ticks 200..{FEED})",
        taken.len(),
        arrived.len(),
    );

    assert!(wakes_due >= 100, "the Balancer slept behind its outlet and was woken at least 100 times ({wakes_due})");
    assert_eq!(wakes_missed, 0, "every slot the outlet freed woke the Balancer on the next tick");
    assert!(
        bal_step_ticks * 2 < window_ticks,
        "the Balancer sleeps: it stepped on {bal_step_ticks} of {window_ticks} ticks"
    );
    assert!(taken.len() > 300, "the Source took a real stream ({})", taken.len());
    assert_eq!(arrived, taken, "every item the Source took reached the collector, in order");
}

/// 87-REVIEW WR-01: a blocked feeder resumes exactly one tick after its consumer frees a
/// slot, WHICHEVER of the two was placed first. This pins the placement-order latency the
/// consumer wake chose, so a later change to it is seen.
///
/// The board is the slow-outlet one above without the inlet: a Source straight into a
/// one-Out Balancer, a 1-tile outlet belt paced 8 ticks per slot, and a collector, fed
/// every tick it accepts. It is built twice, the only difference being the order the
/// nodes are created in, which is the order the fold steps them in (ascending `NodeId`):
/// "feeder first" creates the Balancer before the outlet, "consumer first" creates the
/// outlet (and the collector) before the Source and the Balancer, as a user does who lays
/// the belt and then places the machine that feeds it.
///
/// Read at every tick boundary of ticks 200 to 599: the outlet's staging inbox, which the
/// Balancer fills and the belt empties one item per 8 ticks. A slot the belt frees on tick
/// T is refilled on tick T + 1 in both orders, so the inbox reads `cap - 1` at one boundary
/// in every 8 and `cap` at the other 7, and the collector takes the same items on the same
/// ticks in both orders.
///
/// THE ORDER-DEPENDENT CHANGE THIS PINS. Before plan 87-06 a blocked machine re-scheduled
/// itself every tick. In the "consumer first" order the outlet steps before the Balancer
/// within a tick, so the old spinning Balancer refilled the freed slot on tick T itself and
/// the inbox read `cap` at every boundary (measured by the review at a pre-release revision:
/// `{16: 400}`). The sleeping Balancer is woken by the consumer wake at `now + 1`, never
/// `wake_now` (`tick.rs` says why), so in that order a jam now clears one hop per tick
/// where it used to clear within the tick. Deliveries are unchanged: the outlet is the
/// bottleneck in both. A change that brings the same-tick refill back reddens this test,
/// and so does one that delays the wake further.
#[test]
fn a_blocked_feeder_resumes_one_tick_after_its_slot_frees_in_either_order() {
    const PACE: u32 = 8;
    const WINDOW: std::ops::Range<u64> = 200..600;

    struct Reading {
        staging_at_boundary: std::collections::BTreeMap<usize, u64>,
        refill_latencies: std::collections::BTreeMap<u64, u64>,
        arrivals: Vec<(u64, Vec<u8>)>,
    }

    let run = |consumer_first: bool| -> Reading {
        let mut core = Core::genesis(header(0x87_0604));
        let (s, bal, outlet, collector) = if consumer_first {
            let collector = core.state.add_source();
            let outlet = core.state.add_belt(1);
            let s = core.state.add_source();
            let bal = core.state.add_balancer(1);
            (s, bal, outlet, collector)
        } else {
            let s = core.state.add_source();
            let bal = core.state.add_balancer(1);
            let outlet = core.state.add_belt(1);
            let collector = core.state.add_source();
            (s, bal, outlet, collector)
        };
        assert_eq!(bal > outlet, consumer_first, "the creation order sets the step order");
        core.state.link((s, 0), (bal, 0));
        core.state.link((bal, 0), (outlet, 0));
        core.state.link((outlet, 0), (collector, 0));
        pace_belt(&mut core, outlet, PACE);

        let mut reading = Reading {
            staging_at_boundary: std::collections::BTreeMap::new(),
            refill_latencies: std::collections::BTreeMap::new(),
            arrivals: Vec::new(),
        };
        let mut freed_at: Option<u64> = None;
        let mut seq = 0u64;
        while core.tick < WINDOW.end {
            let t = core.tick;
            let evs = if source_would_accept(&core, s) {
                seq += 1;
                vec![fire(s, seq, t, Item(seq.to_le_bytes().to_vec()))]
            } else {
                Vec::new()
            };
            core.advance(&evs);
            let staging = inbox_len(&core, outlet, 0);
            if WINDOW.contains(&t) {
                *reading.staging_at_boundary.entry(staging).or_insert(0) += 1;
                match (staging < INBOX_CAP, freed_at) {
                    (true, None) => freed_at = Some(t),
                    (false, Some(f)) => {
                        *reading.refill_latencies.entry(t - f).or_insert(0) += 1;
                        freed_at = None;
                    }
                    _ => {}
                }
            }
            while let Some((_seq, item)) = core.state.inbox_mut(collector).take(0) {
                reading.arrivals.push((t, item.0));
            }
        }
        reading
    };

    let first = run(false);
    let last = run(true);
    eprintln!(
        "WR01 feeder_first staging_at_boundary={:?} refill_latencies={:?} arrivals={} | consumer_first \
         staging_at_boundary={:?} refill_latencies={:?} arrivals={} | same_arrivals={}",
        first.staging_at_boundary,
        first.refill_latencies,
        first.arrivals.len(),
        last.staging_at_boundary,
        last.refill_latencies,
        last.arrivals.len(),
        first.arrivals == last.arrivals,
    );

    let ticks = WINDOW.end - WINDOW.start;
    let frees = ticks / u64::from(PACE);
    let want_staging: std::collections::BTreeMap<usize, u64> =
        [(INBOX_CAP - 1, frees), (INBOX_CAP, ticks - frees)].into_iter().collect();
    for (name, r) in [("feeder first", &first), ("consumer first", &last)] {
        assert_eq!(
            r.staging_at_boundary, want_staging,
            "{name}: the outlet's staging inbox reads cap - 1 at one boundary in every {PACE} and cap at the rest"
        );
        assert!(
            r.refill_latencies.keys().all(|&l| l == 1) && r.refill_latencies.values().sum::<u64>() + 1 >= frees,
            "{name}: every freed slot is refilled exactly one tick later (read {:?})",
            r.refill_latencies
        );
    }
    assert!(first.arrivals.len() as u64 >= frees - 1, "the outlet delivered a real stream ({})", first.arrivals.len());
    assert_eq!(first.arrivals, last.arrivals, "the collector takes the same items on the same ticks in both orders");
}

/// Plan 87-06, JAM-04, D-06: the consumer wake touches only sleepers.
///
/// A Source docked straight onto a one-Out Balancer, a 1-tile belt and a collector, with
/// one event every 50 ticks, so nothing is ever blocked. Each item is consumed twice (the
/// Balancer takes it off its inbox, the belt takes it off its staging inbox), so each
/// consumer's inbox shrinks while its feeder is awake. After every tick neither feeder may
/// sit in the sleep set or hold a wheel entry for the next tick: a research prototype that
/// woke every feeder of a shrinking inbox scheduled them and moved golden 0001 for nothing.
#[test]
fn a_consumer_wakes_only_sleeping_feeders() {
    const ITEMS: u64 = 10;
    const EVERY: u64 = 50;

    let mut core = Core::genesis(header(0x87_0603));
    let s = core.state.add_source();
    let bal = core.state.add_balancer(1);
    let belt = core.state.add_belt(1);
    let collector = core.state.add_source();
    core.state.link((s, 0), (bal, 0));
    core.state.link((bal, 0), (belt, 0));
    core.state.link((belt, 0), (collector, 0));

    let mut arrived = 0u64;
    let (mut bal_consumed, mut belt_consumed) = (0u64, 0u64);
    let mut seq = 0u64;
    while core.tick < ITEMS * EVERY + 200 {
        let t = core.tick;
        let evs = if t.is_multiple_of(EVERY) && t < ITEMS * EVERY {
            seq += 1;
            vec![fire(s, seq, t, Item(vec![7]))]
        } else {
            Vec::new()
        };
        let belt_before = inbox_len(&core, belt, 0);
        core.advance(&evs);
        let stepped = &core.last_tick.stepped;
        // The Source's fire reaches the Balancer's inbox and the Balancer takes it off in
        // the same tick (an instant link), so its consumption is read as its step on a
        // tick that carried an event.
        if stepped.contains(&bal) && !evs.is_empty() {
            bal_consumed += 1;
        }
        if stepped.contains(&belt) && inbox_len(&core, belt, 0) < belt_before {
            belt_consumed += 1;
        }
        for feeder in [s, bal] {
            assert!(!core.sched.is_blocked(feeder), "tick {t}: a feeder that was never gated is not asleep");
            assert!(
                !core.sched.is_scheduled_at(feeder, core.tick),
                "tick {t}: the consumer wake scheduled a feeder that was not asleep"
            );
        }
        arrived += drain_collector(&mut core, collector) as u64;
    }
    eprintln!("ONLY-SLEEPERS arrived={arrived} balancer_fire_ticks={bal_consumed} belt_staging_takes={belt_consumed}");
    assert_eq!(arrived, ITEMS, "every item crossed both consumers (non-vacuity)");
    assert_eq!(bal_consumed, ITEMS, "the Balancer took every item off its inbox (non-vacuity)");
    assert!(belt_consumed >= ITEMS, "the belt took every item off its staging inbox ({belt_consumed})");
}

/// Is `belt`'s tail slot occupied? (false for any other kind).
fn tail_occupied(core: &Core, belt: NodeId) -> bool {
    match core.state.node(belt) {
        Some(Node::Belt(b)) => b.slots.last().is_some_and(Option::is_some),
        _ => false,
    }
}

/// Plan 87-07, JAM-04, D-06: a settled belt sleeps, and the machine that frees its head's
/// slot wakes it.
///
/// Source, a 2-tile inlet belt, a one-Out Balancer, a 1-tile outlet belt paced at 8 ticks
/// per slot, and a collector (a Source, which ignores its input) drained every tick. The
/// Source is fed one tagged event per tick whenever it would accept one, for 3000 ticks,
/// then the board runs until every item is in. The Balancer is faster than its outlet, so
/// its inbox sits at the cap and the inlet packs against it: head held, items packed from
/// the head, tail full. That belt is SETTLED, so it sleeps. On every tick the inlet started
/// asleep and the Balancer took an item off its inbox, the inlet must step on the next tick
/// (the consumer wake, at `now + 1`); it must end at least a third of the window's ticks
/// asleep and step on at most three quarters of them; and every item the Source took
/// reaches the collector, in order. (Measured: it steps on half. Each 8-tick cycle it
/// steps to deliver its head, to close the gap and admit, and once more for the Source's
/// delivery into its staging inbox, which wakes a sleeping belt for one step as a delivery
/// wakes a sleeping machine.)
/// Before this plan a belt holding items stepped on every tick and never slept, so the
/// wake count read 0.
#[test]
fn a_settled_belt_wakes_when_its_head_frees() {
    const FEED: u64 = 3000;
    const DRAIN_BUDGET: u64 = 20_000;
    const PACE: u32 = 8;

    let mut core = Core::genesis(header(0x87_0701));
    let s = core.state.add_source();
    let inlet = core.state.add_belt(2);
    let bal = core.state.add_balancer(1);
    let outlet = core.state.add_belt(1);
    let collector = core.state.add_source();
    core.state.link((s, 0), (inlet, 0));
    core.state.link((inlet, 0), (bal, 0));
    core.state.link((bal, 0), (outlet, 0));
    core.state.link((outlet, 0), (collector, 0));
    pace_belt(&mut core, outlet, PACE);

    let mut taken: Vec<Vec<u8>> = Vec::new();
    let mut arrived: Vec<Vec<u8>> = Vec::new();
    let mut seq = 0u64;
    let mut wake_due: Option<u64> = None;
    let (mut wakes_due, mut wakes_kept, mut wakes_missed) = (0u64, 0u64, 0u64);
    let (mut inlet_step_ticks, mut inlet_asleep_ticks, mut window_ticks) = (0u64, 0u64, 0u64);
    while core.tick < FEED + DRAIN_BUDGET {
        let t = core.tick;
        let feeding = t < FEED;
        let evs = if feeding && source_would_accept(&core, s) {
            seq += 1;
            let tag = seq.to_le_bytes().to_vec();
            taken.push(tag.clone());
            vec![fire(s, seq, t, Item(tag))]
        } else {
            Vec::new()
        };
        let asleep_before = core.sched.is_blocked(inlet);
        let bal_before = inbox_len(&core, bal, 0);
        core.advance(&evs);
        let stepped = core.last_tick.stepped.contains(&inlet);
        if let Some(due) = wake_due.take() {
            assert_eq!(due, t, "a due wake is read on its own tick");
            if stepped {
                wakes_kept += 1;
            } else {
                wakes_missed += 1;
            }
        }
        if asleep_before && inbox_len(&core, bal, 0) < bal_before {
            wakes_due += 1;
            wake_due = Some(t + 1);
        }
        if (200..FEED).contains(&t) {
            window_ticks += 1;
            inlet_step_ticks += u64::from(stepped);
            inlet_asleep_ticks += u64::from(core.sched.is_blocked(inlet));
        }
        while let Some((_seq, item)) = core.state.inbox_mut(collector).take(0) {
            arrived.push(item.0);
        }
        if !feeding && arrived.len() == taken.len() {
            break;
        }
    }
    eprintln!(
        "SETTLED-HEAD taken={} arrived={} wakes_due={wakes_due} wakes_kept={wakes_kept} wakes_missed={wakes_missed} \
         inlet_step_ticks={inlet_step_ticks} inlet_asleep_ticks={inlet_asleep_ticks} of {window_ticks} (ticks 200..{FEED})",
        taken.len(),
        arrived.len(),
    );

    assert!(wakes_due >= 100, "the inlet slept behind the Balancer and was woken at least 100 times ({wakes_due})");
    assert_eq!(wakes_missed, 0, "every slot the Balancer freed woke the inlet on the next tick");
    assert!(
        inlet_asleep_ticks * 3 >= window_ticks,
        "the inlet sleeps: asleep after {inlet_asleep_ticks} of {window_ticks} ticks"
    );
    assert!(
        inlet_step_ticks * 4 <= window_ticks * 3,
        "the inlet does not step every tick: it stepped on {inlet_step_ticks} of {window_ticks}"
    );
    assert!(taken.len() > 300, "the Source took a real stream ({})", taken.len());
    assert_eq!(arrived, taken, "every item the Source took reached the collector, in order");
}

/// Plan 87-07, JAM-04, D-06: a belt settled against a downstream BELT is woken by that
/// belt's tail coming free.
///
/// Source, a 2-tile belt A, a 1-tile belt B paced at 8 ticks per slot, and a collector
/// drained every tick, fed as `a_settled_belt_wakes_when_its_head_frees` is. A's head goes
/// straight into B's tail slot (the belt-to-belt arm), never through B's staging inbox, so
/// B's inbox never shrinks and the consumer wake alone would never reach A: the wake that
/// does is the tail-freed one (a belt whose tail slot was occupied before its step and is
/// free after it wakes its sleeping feeders). On every tick A started asleep and B's tail
/// went from occupied to free, A must step on the next tick, A must sleep on most ticks of
/// the window, and every item must arrive in order. With the tail-freed wake removed, A
/// never resumes.
#[test]
fn a_settled_belt_wakes_when_its_downstream_belt_frees() {
    const FEED: u64 = 3000;
    const DRAIN_BUDGET: u64 = 20_000;
    const PACE: u32 = 8;

    let mut core = Core::genesis(header(0x87_0702));
    let s = core.state.add_source();
    let a = core.state.add_belt(2);
    let b = core.state.add_belt(1);
    let collector = core.state.add_source();
    core.state.link((s, 0), (a, 0));
    core.state.link((a, 0), (b, 0));
    core.state.link((b, 0), (collector, 0));
    pace_belt(&mut core, b, PACE);

    let mut taken: Vec<Vec<u8>> = Vec::new();
    let mut arrived: Vec<Vec<u8>> = Vec::new();
    let mut seq = 0u64;
    let mut wake_due: Option<u64> = None;
    let (mut wakes_due, mut wakes_kept, mut wakes_missed) = (0u64, 0u64, 0u64);
    let (mut a_step_ticks, mut a_asleep_ticks, mut window_ticks) = (0u64, 0u64, 0u64);
    while core.tick < FEED + DRAIN_BUDGET {
        let t = core.tick;
        let feeding = t < FEED;
        let evs = if feeding && source_would_accept(&core, s) {
            seq += 1;
            let tag = seq.to_le_bytes().to_vec();
            taken.push(tag.clone());
            vec![fire(s, seq, t, Item(tag))]
        } else {
            Vec::new()
        };
        let asleep_before = core.sched.is_blocked(a);
        let tail_before = tail_occupied(&core, b);
        core.advance(&evs);
        let stepped = core.last_tick.stepped.contains(&a);
        if let Some(due) = wake_due.take() {
            assert_eq!(due, t, "a due wake is read on its own tick");
            if stepped {
                wakes_kept += 1;
            } else {
                wakes_missed += 1;
            }
        }
        if asleep_before && tail_before && !tail_occupied(&core, b) {
            wakes_due += 1;
            wake_due = Some(t + 1);
        }
        if (200..FEED).contains(&t) {
            window_ticks += 1;
            a_step_ticks += u64::from(stepped);
            a_asleep_ticks += u64::from(core.sched.is_blocked(a));
        }
        while let Some((_seq, item)) = core.state.inbox_mut(collector).take(0) {
            arrived.push(item.0);
        }
        if !feeding && arrived.len() == taken.len() {
            break;
        }
    }
    eprintln!(
        "SETTLED-TAIL taken={} arrived={} wakes_due={wakes_due} wakes_kept={wakes_kept} wakes_missed={wakes_missed} \
         a_step_ticks={a_step_ticks} a_asleep_ticks={a_asleep_ticks} of {window_ticks} (ticks 200..{FEED})",
        taken.len(),
        arrived.len(),
    );

    assert!(wakes_due >= 100, "A slept behind B's tail and was woken at least 100 times ({wakes_due})");
    assert_eq!(wakes_missed, 0, "every tail slot B freed woke A on the next tick");
    assert!(a_step_ticks * 2 < window_ticks, "A sleeps: it stepped on {a_step_ticks} of {window_ticks} ticks");
    assert!(taken.len() > 300, "the Source took a real stream ({})", taken.len());
    assert_eq!(arrived, taken, "every item the Source took reached the collector, in order");
}

/// Plan 87-07, JAM-04, D-06, PILE-07: a belt that could still move never sleeps.
///
/// Leg 1, A GAP BEHIND A RETAINED HEAD: a 2-tile belt whose head docks nowhere holds items
/// in slots 0 and 3, at one slot per tick. While a gap stands behind the head it must stay
/// awake (scheduled for the next tick, not in the sleep set), so it closes forward; once it
/// is packed from the head (slots 0 and 1, tail free, nothing staged) it sleeps. A belt
/// that slept with the gap would freeze where it stood, which is what PILE-07 forbids.
///
/// Leg 2, A FREE TAIL WITH AN ITEM STAGED: a 1-tile belt holding only its retained head is
/// settled and sleeps; a Source then delivers one item into its staging inbox. The belt
/// must leave the sleep set and be scheduled for the next tick on that same tick, admit
/// the item, close the new gap, and only then sleep again with both items.
#[test]
fn an_unsettled_belt_never_sleeps() {
    // Leg 1.
    let mut core = Core::genesis(header(0x87_0703));
    let belt = core.state.add_belt(2);
    pace_belt(&mut core, belt, 1);
    match core.state.node_mut(belt) {
        Some(Node::Belt(b)) => {
            b.slots[0] = Some(Item(vec![1]));
            b.slots[3] = Some(Item(vec![2]));
        }
        _ => unreachable!("a belt"),
    }
    let t0 = core.tick;
    core.sched.schedule_wake(belt, t0);
    let packed = |core: &Core| match core.state.node(belt) {
        Some(Node::Belt(b)) => b.slots[0].is_some() && b.slots[1].is_some() && b.slots[2..].iter().all(Option::is_none),
        _ => false,
    };
    let mut awake_with_gap = 0u32;
    let mut slept_at: Option<u64> = None;
    for _ in 0..20 {
        core.advance(&[]);
        if packed(&core) {
            if core.sched.is_blocked(belt) {
                slept_at.get_or_insert(core.tick);
            }
        } else {
            assert!(!core.sched.is_blocked(belt), "tick {}: a belt with a gap behind its head sleeps", core.tick);
            assert!(core.sched.is_scheduled_at(belt, core.tick), "tick {}: a belt with a gap is scheduled", core.tick);
            awake_with_gap += 1;
        }
    }
    eprintln!("UNSETTLED leg 1: awake_with_gap={awake_with_gap} slept_at={slept_at:?}");
    assert!(awake_with_gap >= 1, "the gap stood for at least one tick (non-vacuity)");
    assert!(slept_at.is_some(), "once packed from the head the belt sleeps");
    assert!(!core.sched.is_scheduled_at(belt, core.tick), "an asleep belt holds no wake");

    // Leg 2.
    let mut core = Core::genesis(header(0x87_0704));
    let belt = core.state.add_belt(1);
    let s = core.state.add_source();
    core.state.link((s, 0), (belt, 0));
    pace_belt(&mut core, belt, 1);
    if let Some(Node::Belt(b)) = core.state.node_mut(belt) {
        b.slots[0] = Some(Item(vec![1]));
    }
    let t0 = core.tick;
    core.sched.schedule_wake(belt, t0);
    core.advance(&[]);
    assert!(core.sched.is_blocked(belt), "a belt holding only its retained head is settled and sleeps");
    let t = core.tick;
    core.advance(&[fire(s, 1, t, Item(vec![2]))]);
    assert_eq!(inbox_len(&core, belt, 0), 1, "the Source's item is staged on the belt");
    assert!(!core.sched.is_blocked(belt), "a free tail with an item staged is not settled: the delivery wakes it");
    assert!(core.sched.is_scheduled_at(belt, core.tick), "the woken belt is scheduled for the next tick");
    let mut slept_again: Option<u64> = None;
    for _ in 0..20 {
        core.advance(&[]);
        if core.sched.is_blocked(belt) {
            slept_again.get_or_insert(core.tick);
            break;
        }
    }
    eprintln!("UNSETTLED leg 2: slept_again={slept_again:?} items={}", belt_items(&core, belt));
    assert_eq!(belt_items(&core, belt), 2, "the staged item was admitted (nothing lost)");
    assert!(slept_again.is_some(), "packed again, the belt sleeps again");
}

/// The Source kind byte (`tick::machine_kind::SOURCE`).
const KIND_SOURCE: u8 = 0;

/// An edit-built Source at `(0, 0)` with one Out on its east side, a two-tile belt drawn
/// east from `(1, 0)` and Tail-docked on that Out, its head docked nowhere. The Source is
/// fed one event per tick until it holds a backlog and the belt and its staging inbox are
/// full, then the board runs on until the Source is asleep behind it. Returns
/// `(core, source, belt, next edit seq)`.
fn source_asleep_behind_a_full_belt(seed: u64) -> (Core, NodeId, NodeId, u64) {
    let mut core = Core::genesis(header(seed));
    let place = edit(
        &core,
        1,
        EditOp::Place {
            kind: KIND_SOURCE,
            cell_x: 0,
            cell_y: 0,
            w: 1,
            h: 1,
            ports: vec![Port { local_offset: (0, 0), side: Side::E, role: Role::Out, medium: Medium::Mechanical }],
            rot: 0,
        },
    );
    core.advance_edits(&[place], &[]);
    let s = *core.last_tick.placed.last().expect("the Source was minted");
    let belt = draw_belt_east(&mut core, 2, 1, 0);
    let dock = edit(&core, 3, EditOp::Dock { belt, endpoint: BeltEnd::Tail, node: s, port: 0 });
    core.advance_edits(&[dock], &[]);
    let mut seq = 0u64;
    for _ in 0..200 {
        let t = core.tick;
        let evs = if source_would_accept(&core, s) {
            seq += 1;
            vec![fire(s, seq, t, Item(vec![5]))]
        } else {
            Vec::new()
        };
        core.advance(&evs);
    }
    for _ in 0..50 {
        core.advance(&[]);
    }
    (core, s, belt, 4)
}

/// One leg of the edit-wake test: given `(source, belt)`, the edit that lifts the block.
type BlockLift = fn(NodeId, NodeId) -> EditOp;

/// Plan 87-06, JAM-04, D-06, Pitfall 8, threat T-87-16: an edit wakes a blocked machine.
///
/// A Source asleep behind a full belt whose head docks nowhere. Four legs, each on a fresh
/// copy of the board: a Disconnect of the belt from the Source, a Delete of the belt, a
/// RemovePort of the Source's Out, and a Rotate of the Source. Each removes the Source's
/// only link without any consumer stepping, so only the edit wake can resume it. On the
/// edit's own tick the Source must step, leave the sleep set and give up one item of its
/// backlog; within 100 ticks its backlog must be empty (with no link, its items leave to
/// nowhere, the missing-link no-op). With the edit wake removed every leg stays asleep.
#[test]
fn an_edit_wakes_a_blocked_machine() {
    let legs: [(&str, BlockLift); 4] = [
        ("disconnect", |s, belt| EditOp::Unlink { belt, endpoint: BeltEnd::Tail, node: s, port: 0 }),
        ("delete the belt", |_s, belt| EditOp::Delete {
            node: belt,
            kind: KIND_BELT,
            cell_x: 1,
            cell_y: 0,
            captured: DeletedSubgraph::default(),
        }),
        ("remove the Out port", |s, _belt| EditOp::RemovePort { node: s, index: 0, restore: None }),
        ("rotate the Source", |s, _belt| EditOp::Rotate { node: s, new_rot: 1, old_rot: 0 }),
    ];
    let mut facts = Vec::new();
    let mut failures = Vec::new();
    for (name, make) in legs {
        let (mut core, s, belt, seq) = source_asleep_behind_a_full_belt(0x87_0604);
        let asleep = core.sched.is_blocked(s);
        let backlog = pending(&core, s);
        let rec = edit(&core, seq, make(s, belt));
        core.advance_edits(&[rec], &[]);
        let stepped = core.last_tick.stepped.contains(&s);
        let still_asleep = core.sched.is_blocked(s);
        let after_edit = pending(&core, s);
        let linked = core.state.link_target((s, 0)).is_some();
        for _ in 0..100 {
            core.advance(&[]);
        }
        let after_run = pending(&core, s);
        facts.push(format!(
            "{name}: asleep_before={asleep} backlog={backlog} stepped_on_edit_tick={stepped} asleep_after={still_asleep} \
             backlog_after_edit={after_edit} out_linked={linked} backlog_after_100={after_run}"
        ));
        if !asleep || backlog == 0 {
            failures.push(format!("{name}: the Source sleeps holding a backlog before the edit"));
        }
        if linked {
            failures.push(format!("{name}: the edit removed the Source's only link"));
        }
        if !stepped || still_asleep || after_edit + 1 != backlog {
            failures.push(format!("{name}: the Source resumes on the edit's tick"));
        }
        if after_run != 0 {
            failures.push(format!("{name}: the Source's backlog empties after the edit"));
        }
    }
    for f in &facts {
        eprintln!("EDIT-WAKE {f}");
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

/// WINDOWS 165, JAM-05 (P165): a Factory whose code emits twice on one port delivers both.
///
/// The Factory's JS calls `ctx.emit(0, input)` twice. Its Source is given one event per
/// tick whenever it would accept one, for 600 ticks, then the board runs until it is
/// empty. The Sink must receive exactly twice the events injected, with zero
/// `OutputRefused` resting on the Factory and `Factory.faults` 0. At the research revision
/// it read 347 delivered of 1200 expected, 16 `OutputRefused` resting on the Factory and
/// 309 more counted in `Factory.faults`.
#[test]
fn a_factory_that_emits_twice_delivers_both() {
    const FEED_TICKS: u64 = 600;
    const DRAIN_LIMIT: u64 = 20_000;
    const TWICE_JS: &str = "export default function (input, ctx) { ctx.emit(0, input); ctx.emit(0, input); }";

    let mut core = Core::genesis(header(0x87_0165));
    let s = core.state.add_source();
    let factory = core
        .state
        .add_factory(TWICE_JS.to_owned(), fabrico_core::factory::DEFAULT_GAS_BUDGET, 7);
    let belt = core.state.add_belt(1);
    let sink = core.state.add_sink(SinkTemplate::Debug, 0);
    core.state.link((s, 0), (factory, 0));
    core.state.link((factory, 0), (belt, 0));
    core.state.link((belt, 0), (sink, 0));

    let (mut injected, mut delivered, mut seq) = (0usize, 0usize, 0u64);
    let mut max_refused_on_factory = 0usize;
    for _ in 0..FEED_TICKS {
        let t = core.tick;
        let evs = if source_would_accept(&core, s) {
            seq += 1;
            injected += 1;
            vec![fire(s, seq, t, Item(b"1".to_vec()))]
        } else {
            Vec::new()
        };
        delivered += sink_messages(&core.advance(&evs), sink).len();
        max_refused_on_factory = max_refused_on_factory.max(refused_on(&core, factory));
    }
    // Since plan 87-04 the Factory's own queue is part of "empty": a board whose belt and
    // inboxes are clear while emits still wait in `pending_emits` has not drained.
    let empty = |core: &Core| {
        pending(core, s) == 0
            && queued(core, factory).is_empty()
            && inbox_len(core, factory, 0) == 0
            && inbox_len(core, belt, 0) == 0
            && belt_items(core, belt) == 0
            && inbox_len(core, sink, 0) == 0
    };
    let mut drained_at = None;
    while core.tick < FEED_TICKS + DRAIN_LIMIT {
        delivered += sink_messages(&core.advance(&[]), sink).len();
        max_refused_on_factory = max_refused_on_factory.max(refused_on(&core, factory));
        if empty(&core) {
            drained_at = Some(core.tick);
            break;
        }
    }
    let faults = match core.state.node(factory) {
        Some(Node::Factory(f)) => f.faults,
        o => panic!("expected the Factory, got {o:?}"),
    };
    let resting = refused_on(&core, factory);
    // What rests on the Factory's fault port, by reason (the D-08 reading names it).
    let mut by_reason: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    if let Some(inbox) = core.state.inbox_of(factory) {
        for item in inbox.items_on(FAULT_PORT) {
            let reason = Fault::decode(item).map_or_else(|_| "undecodable".to_owned(), |f| format!("{:?}", f.reason));
            *by_reason.entry(reason).or_insert(0) += 1;
        }
    }
    eprintln!("P165 resting_on_factory_fault_port_by_reason={by_reason:?}");
    eprintln!(
        "P165 feed_ticks={FEED_TICKS} injected={injected} expected={} delivered={delivered} drained_at={drained_at:?} \
         output_refused_resting_on_factory={resting} max_resting={max_refused_on_factory} factory_faults={faults}",
        2 * injected,
    );

    assert!(drained_at.is_some(), "the board empties within {DRAIN_LIMIT} ticks of the feed ending");
    assert_eq!(delivered, 2 * injected, "every one of the two emits per event arrives");
    assert_eq!(max_refused_on_factory, 0, "no OutputRefused ever rests on the Factory");
    assert_eq!(faults, 0, "Factory.faults stays 0");
}

/// A Factory's waiting emits, as `(port, items waiting)` in port order (empty for any other
/// kind). Plan 87-04's queue, read off the state.
fn queued(core: &Core, id: NodeId) -> Vec<(PortId, usize)> {
    match core.state.node(id) {
        Some(Node::Factory(f)) => f.pending_emits.iter().map(|(&p, q)| (p, q.len())).collect(),
        _ => Vec::new(),
    }
}

/// Plan 87-04, JAM-05, D-07: the queue drains one item per queued port per step, and a step
/// whose queue is not empty takes no input.
///
/// The Factory's JS emits its input three times on Out 0 and once on Out 1, both Outs
/// linked straight to a collector (a Source, which ignores its input, so delivered items
/// rest in its inbox). One logged `Input` reaches the Factory's In 0 at each of ticks 0 to
/// 3. An `Input` is admitted at the tick boundary, before any node steps, so the Factory
/// steps exactly once a tick here; a delivery made DURING the fold re-wakes a machine for a
/// second gated step in the same tick, which is the fold's rule for every machine, and the
/// queue's unit is the step. Read after each tick as `(Out 0 delivered, Out 1 delivered,
/// Out 0 queue, Factory inbox)`: the run's first emit per port leaves at once and two wait;
/// the next two steps push one each and take no input, so the Factory's inbox grows; the
/// emptied queue is removed from the map; then the next input is taken.
#[test]
fn a_factory_queue_drains_one_per_port_and_takes_no_input() {
    const THREE_AND_ONE_JS: &str =
        "export default function (input, ctx) { ctx.emit(0, input); ctx.emit(0, input); ctx.emit(0, input); ctx.emit(1, input); }";
    let mut core = Core::genesis(header(0x87_0465));
    let f = core
        .state
        .add_factory(THREE_AND_ONE_JS.to_owned(), fabrico_core::factory::DEFAULT_GAS_BUDGET, 7);
    let c0 = core.state.add_source();
    let c1 = core.state.add_source();
    core.state.link((f, 0), (c0, 0));
    core.state.link((f, 1), (c1, 0));

    let mut trace = Vec::new();
    let mut keys = Vec::new();
    for t in 0..4u64 {
        core.advance(&[input_to(f, t + 1, t)]);
        let q0 = queued(&core, f).iter().find(|(p, _)| *p == 0).map_or(0, |(_, n)| *n);
        trace.push((inbox_len(&core, c0, 0), inbox_len(&core, c1, 0), q0, inbox_len(&core, f, 0)));
        keys.push(queued(&core, f).iter().map(|(p, _)| *p).collect::<Vec<_>>());
    }
    eprintln!("P165-queue (out0, out1, queue0, factory_inbox) per tick = {trace:?} queue_keys={keys:?}");

    assert_eq!(
        trace,
        vec![(1, 1, 2, 0), (2, 1, 1, 1), (3, 1, 0, 2), (4, 2, 2, 2)],
        "one out per port per run, two wait on Out 0; two steps push one each and take no input; then an input is taken",
    );
    assert_eq!(keys[2], Vec::<PortId>::new(), "an emptied queue is removed from the map, never left empty");
}

/// A logged `Input` of the JSON item `1` into `target`'s In 0 at `tick`. Admitted into the
/// inbox at the tick boundary, before any node steps.
fn input_to(target: NodeId, seq: u64, tick: u64) -> Event {
    Event {
        schema_version: SCHEMA_VERSION,
        partition: 0,
        sequence: seq,
        tick,
        payload: EventPayload::Input { target, port: 0, item: Item(b"1".to_vec()) },
    }
}

/// Plan 87-04, JAM-05, D-07: only a port the Factory has a link from is queued. The JS emits
/// twice on the linked Out 0 and twice on port 3, which no link names: Out 0's second emit
/// waits, and port 3 holds no queue at all (its first emit is a no-op at the drain, as an
/// emit on an unlinked port always was, and so is its second).
#[test]
fn an_unlinked_port_is_never_queued() {
    const LINKED_AND_NOT_JS: &str =
        "export default function (input, ctx) { ctx.emit(0, input); ctx.emit(0, input); ctx.emit(3, input); ctx.emit(3, input); }";
    let mut core = Core::genesis(header(0x87_0466));
    let s = core.state.add_source();
    let f = core
        .state
        .add_factory(LINKED_AND_NOT_JS.to_owned(), fabrico_core::factory::DEFAULT_GAS_BUDGET, 7);
    let c0 = core.state.add_source();
    core.state.link((s, 0), (f, 0));
    core.state.link((f, 0), (c0, 0));
    core.advance(&[fire(s, 1, 0, Item(b"1".to_vec()))]);
    let q = queued(&core, f);
    eprintln!("P165-unlinked out0={} queue={q:?}", inbox_len(&core, c0, 0));
    assert_eq!(q, vec![(0, 1)], "Out 0's second emit waits and port 3, unlinked, is never queued");
    assert!(
        snapshot::restore(&snapshot::snapshot(&core)).is_ok(),
        "the board with a queue on a linked port saves and reopens"
    );
}

/// `fold_place`'s Factory kind byte (`tick::machine_kind::FACTORY`), restated at the line
/// as `remove_port_repoint.rs` restates the Router's.
const KIND_FACTORY: u8 = 2;
/// The Belt kind byte (`tick::machine_kind::BELT`).
const KIND_BELT: u8 = 1;

/// An edit record at the current tick.
fn edit(core: &Core, seq: u64, op: EditOp) -> EditRecord {
    EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: seq,
        tick: core.tick,
        action: 0,
        op,
    }
}

/// A two-tile belt running east from `(x, y)`, drawn by an edit; returns its id.
fn draw_belt_east(core: &mut Core, seq: u64, x: i32, y: i32) -> NodeId {
    let op = EditOp::DrawBelt {
        tiles: vec![
            BeltTile::new((x, y), TileKind::Straight { axis: Axis::X }),
            BeltTile::new((x + 1, y), TileKind::Straight { axis: Axis::X }),
        ],
    };
    let rec = edit(core, seq, op);
    core.advance_edits(&[rec], &[]);
    *core.last_tick.placed.last().expect("the belt was minted")
}

/// The edit-built board the link-removal legs share: a 2x3 Factory placed at `(0,0)` with
/// ports `[In row 1, Out row 1, Out row 2, Out row 0]` (Out keys 0, 1 and 2, the
/// `remove_port_repoint.rs` catalog layout), its JS emitting its input three times on Out
/// key 0 and three times on Out key 2, and a belt Tail-docked on each of those two Outs at
/// its doorstep. One `Input` reaches the Factory and runs it, so two items wait on key 0
/// and two on key 2. Returns `(core, factory, belt on key 0, belt on key 2, next seq)`.
fn factory_with_waiting_emits(seed: u64) -> (Core, NodeId, NodeId, NodeId, u64) {
    factory_with_n_emits(seed, 3)
}

/// [`factory_with_waiting_emits`] with `n` emits per port instead of three, so `n - 1`
/// wait on each of key 0 and key 2 after the run.
fn factory_with_n_emits(seed: u64, n: usize) -> (Core, NodeId, NodeId, NodeId, u64) {
    let js = format!(
        "export default function (input, ctx) {{ for (const p of [0, 2]) {{ for (let i = 0; i < {n}; i++) {{ ctx.emit(p, input); }} }} }}"
    );
    let port = |role: Role, side: Side, x: i32, row: i32| Port { local_offset: (x, row), side, role, medium: Medium::Mechanical };
    let mut core = Core::genesis(header(seed));
    let place = edit(
        &core,
        1,
        EditOp::Place {
            kind: KIND_FACTORY,
            cell_x: 0,
            cell_y: 0,
            w: 2,
            h: 3,
            ports: vec![
                port(Role::In, Side::W, 0, 1),
                port(Role::Out, Side::E, 1, 1),
                port(Role::Out, Side::E, 1, 2),
                port(Role::Out, Side::E, 1, 0),
            ],
            rot: 0,
        },
    );
    core.advance_edits(&[place], &[]);
    let f = *core.last_tick.placed.last().expect("the Factory was minted");
    let configure = edit(
        &core,
        2,
        EditOp::Configure {
            node: f,
            config: MachineConfig::Factory { source: js },
            code_hash: [0u8; 32],
        },
    );
    core.advance_edits(&[configure], &[]);
    // Out key 0 sits at row 1 and key 2 at row 0: doorsteps (2,1) and (2,0).
    let on_0 = draw_belt_east(&mut core, 3, 2, 1);
    let on_2 = draw_belt_east(&mut core, 4, 2, 0);
    let docks = [
        edit(&core, 5, EditOp::Dock { belt: on_0, endpoint: BeltEnd::Tail, node: f, port: 0 }),
        edit(&core, 6, EditOp::Dock { belt: on_2, endpoint: BeltEnd::Tail, node: f, port: 2 }),
    ];
    core.advance_edits(&docks, &[]);
    let t = core.tick;
    core.advance(&[input_to(f, 1, t)]);
    (core, f, on_0, on_2, 7)
}

/// One leg of the link-removal test: given `(factory, belt on key 0)`, the edit that removes
/// a link, the Factory port whose queue must go with it (`None` when the Factory itself
/// goes), and the key the queue that waited on key 2 must be found on after the edit
/// (`None` when the Factory itself goes).
type LinkRemoval = fn(NodeId, NodeId) -> (EditOp, Option<PortId>, Option<PortId>);

/// Items a belt holds or has taken in: its slots plus the staging inbox a machine's offload
/// lands in first (an emit reaches the slots a tick after it leaves the Factory).
fn on_belt(core: &Core, belt: NodeId) -> usize {
    belt_items(core, belt) + inbox_len(core, belt, 0)
}

/// `Factory.faults` (0 once the Factory is gone): the count of items the Factory dropped
/// for want of a link.
fn factory_faults(core: &Core, id: NodeId) -> u64 {
    match core.state.node(id) {
        Some(Node::Factory(f)) => f.faults,
        _ => 0,
    }
}

/// Plan 87-04, JAM-05, T-87-12, and the note plan 87-03 left: a change that removes a
/// Factory output's link while emits wait on it drops that port's queue in the same step,
/// so the board saves into a file that reopens. Since plan 87-03 the snapshot trust gate
/// refuses a queue on a port with no link (`StateInvariant::FactoryPendingEmits`).
///
/// Four legs, each on a fresh copy of the same board with two items waiting on Out key 0
/// and two on Out key 2: a Disconnect of key 0's belt (`Unlink`, the Tail end), a delete of
/// that downstream belt, a port edit that removes key 0's Out (so key 2's belt is re-keyed
/// to 1), and a delete of the Factory itself. After each edit's tick, every queue left on
/// the Factory names a port it has a link from, and the snapshot taken right then restores.
///
/// # What the user loses is graded too (87-REVIEW CR-01)
/// Until the review fix this test graded only the two trust-gate properties, and the port
/// edit leg printed `after=[]` and passed: the edit re-keyed key 2's belt to key 1 and the
/// re-key went through `unlink`, which threw key 2's queue away with the belt still
/// docked. Two more readings per leg now: the dropped key 0 queue is COUNTED in
/// `Factory.faults` (an accepted item never vanishes without a trace, D-03 and T-87-11),
/// and the three emits that were bound for key 2's belt all arrive on it within 200 ticks,
/// wherever the edit put the key, with the queue then empty.
#[test]
fn a_disconnect_drops_a_factorys_queue_for_that_port() {
    let legs: [(&str, LinkRemoval); 4] = [
        ("disconnect key 0's belt", |f, on_0| {
            (EditOp::Unlink { belt: on_0, endpoint: BeltEnd::Tail, node: f, port: 0 }, Some(0), Some(2))
        }),
        ("delete key 0's downstream belt", |_f, on_0| {
            (
                EditOp::Delete { node: on_0, kind: KIND_BELT, cell_x: 2, cell_y: 1, captured: DeletedSubgraph::default() },
                Some(0),
                Some(2),
            )
        }),
        ("remove key 0's Out port", |f, _on_0| {
            (EditOp::RemovePort { node: f, index: 1, restore: None }, Some(0), Some(1))
        }),
        ("delete the Factory", |f, _on_0| {
            (
                EditOp::Delete { node: f, kind: KIND_FACTORY, cell_x: 0, cell_y: 0, captured: DeletedSubgraph::default() },
                None,
                None,
            )
        }),
    ];
    let mut facts = Vec::new();
    let mut failures = Vec::new();
    for (name, make) in legs {
        let (mut core, f, on_0, on_2, seq) = factory_with_waiting_emits(0x87_0467);
        let before = queued(&core, f);
        let on_2_before = on_belt(&core, on_2);
        let (op, dropped, key2_now) = make(f, on_0);
        let rec = edit(&core, seq, op);
        core.advance_edits(&[rec], &[]);
        let after = queued(&core, f);
        let faults_after_edit = factory_faults(&core, f);
        let unlinked: Vec<PortId> =
            after.iter().map(|(p, _)| *p).filter(|p| core.state.link_target((f, *p)).is_none()).collect();
        let reopened = snapshot::restore(&snapshot::snapshot(&core)).map(|_| ()).map_err(|e| format!("{e:?}"));
        let key2_docked = key2_now.map(|k| core.state.link_target((f, k)).map(|(n, _)| n) == Some(on_2));
        let key2_waiting = key2_now.map_or(0, |k| after.iter().find(|(p, _)| *p == k).map_or(0, |(_, n)| *n));
        let on_2_after_edit = on_belt(&core, on_2);
        for _ in 0..200 {
            core.advance(&[]);
        }
        let on_2_settled = on_belt(&core, on_2);
        let queue_settled = queued(&core, f);
        facts.push(format!(
            "{name}: before={before:?} on_2_before={on_2_before} after={after:?} unlinked_queue_ports={unlinked:?} \
             key2_now={key2_now:?} key2_docked={key2_docked:?} key2_waiting={key2_waiting} on_2_after_edit={on_2_after_edit} \
             factory_faults={faults_after_edit} reopens={reopened:?} after_200_ticks: on_2={on_2_settled} queue={queue_settled:?}",
        ));
        if before != vec![(0, 2), (2, 2)] {
            failures.push(format!("{name}: two items wait on key 0 and two on key 2 before the edit (read {before:?})"));
        }
        if let Some(port) = dropped
            && after.iter().any(|(p, _)| *p == port && key2_now != Some(port))
        {
            failures.push(format!("{name}: the queue on key {port} is dropped with its link (read {after:?})"));
        }
        if dropped.is_some() && faults_after_edit != 2 {
            failures.push(format!(
                "{name}: the two items dropped with key 0's link are counted in Factory.faults (read {faults_after_edit})"
            ));
        }
        if !unlinked.is_empty() {
            failures.push(format!("{name}: no queue is left on a port with no link (read {unlinked:?})"));
        }
        if let Err(e) = &reopened {
            failures.push(format!("{name}: the snapshot taken right after the edit reopens (refused: {e})"));
        }
        if key2_now.is_some() {
            if key2_docked != Some(true) {
                failures.push(format!("{name}: key 2's belt is still docked on key {key2_now:?} (read {key2_docked:?})"));
            }
            if key2_waiting + on_2_after_edit != 3 {
                failures.push(format!(
                    "{name}: none of key 2's three emits is lost by the edit: waiting {key2_waiting} + on its belt \
                     {on_2_after_edit} must be 3"
                ));
            }
            if on_2_settled != 3 || !queue_settled.is_empty() {
                failures.push(format!(
                    "{name}: all three of key 2's emits reach its belt and the queue empties (read on_2={on_2_settled} \
                     queue={queue_settled:?})"
                ));
            }
        }
    }
    for f in &facts {
        eprintln!("P165-unlink {f}");
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

/// 87-REVIEW CR-01: a port edit that renumbers a Factory's docked Outs carries each
/// waiting queue to its port's new key, in both directions, and the inverse edit carries it
/// back so the board is exactly the board that was never edited.
///
/// The board of [`factory_with_waiting_emits`] with six emits per port
/// ([`factory_with_n_emits`]), so the queues are still not empty when the second edit
/// lands: five items wait on Out key 0 and five on Out key 2, and Out key 1 (catalog index 2, row 2) has no belt and no queue. Removing that
/// undocked Out releases nothing and re-keys key 2's belt and queue DOWN to 1; adding the
/// same port back at the same index and slot (the record the command layer's Undo writes,
/// `AddPort { seat: Captured }`) re-keys them UP to 2 again. The control is a copy of the
/// board that runs the same two ticks with no edit.
///
/// Read after each edit's tick: the moved queue sits on the port's new key with its belt
/// still docked there, nothing is dropped (`Factory.faults` 0), and the snapshot taken then
/// reopens. After the inverse, the grid state is byte-identical to the control's at the
/// same tick, and after 200 more ticks too.
#[test]
fn a_port_edit_carries_a_factorys_queue_to_the_new_key() {
    let (mut core, f, _on_0, on_2, seq) = factory_with_n_emits(0x87_0468, 6);
    let (mut control, ..) = factory_with_n_emits(0x87_0468, 6);
    let removed = core.state.ports_of(f).expect("the Factory has ports")[2];
    assert_eq!(removed.role, Role::Out, "catalog index 2 is Out key 1");
    let before = queued(&core, f);

    let remove = edit(&core, seq, EditOp::RemovePort { node: f, index: 2, restore: None });
    core.advance_edits(&[remove], &[]);
    control.advance(&[]);
    let after_remove = queued(&core, f);
    let docked_remove = core.state.link_target((f, 1)).map(|(n, _)| n) == Some(on_2);
    let faults_remove = factory_faults(&core, f);
    let reopens_remove = snapshot::restore(&snapshot::snapshot(&core)).map(|_| ()).map_err(|e| format!("{e:?}"));
    let waiting_remove = after_remove.iter().find(|(p, _)| *p == 1).map_or(0, |(_, n)| *n);
    let on_2_remove = on_belt(&core, on_2);

    let add = edit(
        &core,
        seq + 1,
        EditOp::AddPort { node: f, port: removed, index: 2, seat: fabrico_core::edit::PortSeat::Captured },
    );
    core.advance_edits(&[add], &[]);
    control.advance(&[]);
    let after_add = queued(&core, f);
    let docked_add = core.state.link_target((f, 2)).map(|(n, _)| n) == Some(on_2);
    let faults_add = factory_faults(&core, f);
    let reopens_add = snapshot::restore(&snapshot::snapshot(&core)).map(|_| ()).map_err(|e| format!("{e:?}"));
    let same_as_control = grid_state_bytes(&core) == grid_state_bytes(&control);
    let control_after_add = queued(&control, f);
    for _ in 0..200 {
        core.advance(&[]);
        control.advance(&[]);
    }
    let same_after_200 = grid_state_bytes(&core) == grid_state_bytes(&control);
    eprintln!(
        "P165-rekey before={before:?} after_remove={after_remove:?} docked_on_1={docked_remove} on_2={on_2_remove} \
         faults={faults_remove} reopens={reopens_remove:?} | after_add={after_add:?} control={control_after_add:?} \
         docked_on_2={docked_add} faults={faults_add} reopens={reopens_add:?} same_as_control={same_as_control} \
         same_after_200={same_after_200} on_2_after_200={}",
        on_belt(&core, on_2),
    );

    assert_eq!(before, vec![(0, 5), (2, 5)], "five items wait on key 0 and five on key 2 before the edit");
    assert!(docked_remove, "after the removal key 2's belt is docked on key 1");
    assert!(after_remove.iter().all(|(p, _)| *p != 2), "no queue is left on the old key 2");
    assert_eq!(waiting_remove + on_2_remove, 6, "none of key 2's six emits is lost: waiting on key 1 + on its belt");
    assert!(waiting_remove > 0, "the removal re-keys a queue that is not empty yet");
    assert_eq!(faults_remove, 0, "a re-key drops nothing, so nothing is counted");
    assert!(reopens_remove.is_ok(), "the board saves and reopens after the removal: {reopens_remove:?}");
    assert!(docked_add, "after the inverse add key 2's belt is docked on key 2 again");
    assert_eq!(faults_add, 0, "the inverse drops nothing either");
    assert!(reopens_add.is_ok(), "the board saves and reopens after the inverse: {reopens_add:?}");
    assert!(after_add.iter().any(|(p, n)| *p == 2 && *n > 0), "the inverse carries a queue that is not empty yet");
    assert_eq!(after_add, control_after_add, "the inverse puts the queue back where the unedited board has it");
    assert!(same_as_control, "after the inverse the grid state is byte-identical to the unedited board's");
    assert!(same_after_200, "and stays identical for 200 more ticks");
}

/// Plan 87-04, JAM-05, D-07, T-87-11: one run's emits past `FACTORY_EMITS_PER_PORT` on a port
/// each fault on their own, and the 16 within the cap are all delivered.
///
/// A Factory whose JS emits its input 20 times on Out 0 (as `[input, i]`, so the order is
/// readable), Out 0 linked to a collector and its fault port linked to a fault collector
/// (both Sources, which ignore their input, so items rest in their inboxes). One input,
/// then the board runs until both collectors and the Factory's queue are still. The
/// collector holds exactly the first 16 in emission order; the fault collector exactly 4
/// faults, each a `FactoryError` from the Factory whose sentence names port 0 and 16; the
/// Factory reads faulted on the run's tick and drops nothing.
#[test]
fn a_factory_over_the_emit_cap_delivers_sixteen_and_faults_the_rest() {
    const TWENTY_JS: &str =
        "export default function (input, ctx) { for (let i = 0; i < 20; i++) { ctx.emit(0, [input, i]); } }";
    let mut core = Core::genesis(header(0x87_0420));
    let f = core.state.add_factory(TWENTY_JS.to_owned(), fabrico_core::factory::DEFAULT_GAS_BUDGET, 7);
    let c = core.state.add_source();
    let fc = core.state.add_source();
    core.state.link((f, 0), (c, 0));
    core.state.link((f, FAULT_PORT), (fc, 0));

    core.advance(&[input_to(f, 1, 0)]);
    let faulted_on_run_tick = core.last_tick.faulted.contains(&f);
    let mut still = 0;
    while still < 5 && core.tick < 200 {
        let before = (inbox_len(&core, c, 0), inbox_len(&core, fc, 0), queued(&core, f));
        core.advance(&[]);
        let after = (inbox_len(&core, c, 0), inbox_len(&core, fc, 0), queued(&core, f));
        still = if before == after { still + 1 } else { 0 };
    }
    let delivered: Vec<Vec<u8>> =
        core.state.inbox_of(c).map_or(Vec::new(), |i| i.items_on(0).map(|it| it.0.clone()).collect());
    let faults: Vec<Fault> = core
        .state
        .inbox_of(fc)
        .map_or(Vec::new(), |i| i.items_on(0).filter_map(|it| Fault::decode(it).ok()).collect());
    let factory_faults = match core.state.node(f) {
        Some(Node::Factory(fac)) => fac.faults,
        o => panic!("expected the Factory, got {o:?}"),
    };
    let sentences: Vec<String> = faults.iter().map(|x| String::from_utf8_lossy(&x.payload).into_owned()).collect();
    eprintln!(
        "P165-cap delivered={} faults={} reasons={:?} sentences={sentences:?} faulted_on_run_tick={faulted_on_run_tick} \
         resting_on_factory={} factory_faults={factory_faults} queue={:?} tick={}",
        delivered.len(),
        faults.len(),
        faults.iter().map(|x| x.reason.clone()).collect::<Vec<_>>(),
        inbox_len(&core, f, FAULT_PORT),
        queued(&core, f),
        core.tick,
    );

    let want: Vec<Vec<u8>> = (0..16).map(|i| format!("[1,{i}]").into_bytes()).collect();
    assert_eq!(delivered, want, "the collector holds exactly the first 16 emits, in emission order");
    assert_eq!(faults.len(), 4, "the fault collector holds exactly the 4 emits past the cap");
    for (k, x) in faults.iter().enumerate() {
        assert_eq!(x.reason, FaultReason::FactoryError, "refused emit {k} is a FactoryError");
        assert_eq!(x.source, f, "refused emit {k} names the Factory");
        assert!(
            sentences[k].contains("port 0") && sentences[k].contains("16"),
            "refused emit {k}'s sentence names port 0 and the cap 16 (read {:?})",
            sentences[k]
        );
    }
    assert!(faulted_on_run_tick, "the Factory reads faulted on the run's tick");
    assert_eq!(inbox_len(&core, f, FAULT_PORT), 0, "no fault is left resting on the Factory");
    assert_eq!(factory_faults, 0, "and none is dropped");
    assert!(queued(&core, f).is_empty(), "the queue has drained");
}
