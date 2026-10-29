//! The pump / two-log replay-equality suite (TEST-05 seam, RESEARCH Pitfall 2).
//!
//! `GridSession::apply` mutates topology (the edit-log); `GridSession::pump` injects
//! RUNTIME events (`ManualInject`, …) into the live grid and owns a SECOND ordered
//! log. The load-bearing claim this suite proves is the two-log replay-equivalence
//! contract: a session rebuilt from genesis via `replay_two_logs(seed, edits, events)`
//! is BYTE-IDENTICAL to the live session that applied the same edits and pumped the
//! same events. That holds ONLY because `pump` stamps `event.tick = core.tick` with a
//! monotonic event-sequence exactly like `apply`'s W3 discipline (threat T-13-01: the
//! session owns ordering, a caller can never forge a tick), so `run_log_two_logs`
//! regroups the events at the identical tick on replay.
//!
//! Idle `advance` ticks carry NO logged input, so the harness advances BOTH the live
//! and the replayed session by the same count to settle multi-tile belt transport
//! (a belt moves one slot every `ticks_per_slot` ticks — Pitfall 1, SLOT-03) while
//! keeping the cores at the same tick. This read "belts move 1 slot/tick", which is
//! retired by `62-CONTEXT.md` D-01/D-02; that rate is now just the
//! `ticks_per_slot == 1` case. The settle constant below is DERIVED from the interval
//! for that reason - and note that this suite's claim is replay EQUALITY between two
//! sessions advanced by the same count, so an under-run here would not break the
//! equality, only the transport it is meant to have settled first.
//!
//! Run target: `cargo test -p fabrico-command --test pump`.

use fabrico_command::GridSession;
use fabrico_core::event::{Event, EventPayload, SCHEMA_VERSION};
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::snapshot::snapshot;
use fabrico_protocol::{BeltEnd, GridCommand, machine_kind};

const SEED: u64 = 0xFAB_C0DE;

/// Idle ticks advanced (on BOTH sides) to settle the wire-minted belts after the
/// same-tick inject batch. Generous — a wire over 3 cells mints a short belt; once
/// quiescent further idle ticks only advance the (matched) tick counter.
///
/// **DERIVED FROM THE INTERVAL, because it is a BUDGET (SLOT-04).** A belt advances
/// one slot every `ticks_per_slot` ticks, so the ticks a short belt needs to settle
/// scale with it. Budgets are derived (headroom is exactly the thing that should
/// re-derive at every value); assertions are hand-pinned (a number that re-derives is
/// a tautology). The bare 32 was correct only at the identity interval.
const SETTLE: u64 = 32 * fabrico_core::belt_slots::DEFAULT_TICKS_PER_SLOT.get() as u64;

/// Place `kind` at `(cell_x, cell_y)`, returning `(dense handle, minted NodeId)`. The
/// handle feeds `Wire`; the `NodeId` is the `ManualInject` target.
fn place(session: &mut GridSession, kind: u8, cell_x: i32, cell_y: i32) -> (u64, NodeId) {
    session
        .apply(GridCommand::Place { kind, cell_x, cell_y })
        .expect("placement accepted");
    let id = *session
        .core()
        .last_tick
        .placed
        .last()
        .expect("the place minted a node");
    let handle = session.view().handle_of(id).expect("minted node got a handle");
    (handle, id)
}

/// Connect `from`'s Out (port 0) to `to`'s In (port 0) with a drawn belt over `cells`
/// (post-Wire model: DrawBelt then Dock both ends). The belt Tail OFFLOAD-docks `from`
/// and the Head LOAD-docks `to`.
fn connect(session: &mut GridSession, from: u64, to: u64, cells: &[(i32, i32)]) {
    session
        .apply(GridCommand::DrawBelt { cells: cells.to_vec() })
        .expect("a drawn belt is accepted");
    let belt_id = *session.core().last_tick.placed.last().expect("the DrawBelt minted a belt");
    let belt_h = session.view().handle_of(belt_id).expect("belt got a handle");
    session
        .apply(GridCommand::Dock { belt: belt_h, endpoint: BeltEnd::Tail, node: from, port: 0 })
        .expect("the Tail OFFLOAD dock is accepted");
    session
        .apply(GridCommand::Dock { belt: belt_h, endpoint: BeltEnd::Head, node: to, port: 0 })
        .expect("the Head LOAD dock is accepted");
}

/// One `ManualInject` event firing `item` into `target` on port 0. The tick/sequence/
/// partition fields are placeholders — `pump` OVERWRITES them (W3); only the payload
/// survives, which is exactly the property under test.
fn inject(target: NodeId, item: Item) -> Event {
    Event {
        schema_version: SCHEMA_VERSION,
        partition: 0,
        sequence: 0,
        tick: 0,
        payload: EventPayload::ManualInject {
            target,
            port: 0,
            item,
        },
    }
}

/// Build the canonical two-chain sub-graph (two DISTINCT sources, each wired to its
/// own sink), returning the live session and the two source `NodeId`s. Six `apply`s,
/// each its own tick — nothing pumped yet.
fn build_two_chains() -> (GridSession, NodeId, NodeId) {
    let mut session = GridSession::new(SEED);
    let (src_a_h, src_a) = place(&mut session, machine_kind::SOURCE, 0, 0);
    let (sink_a_h, _) = place(&mut session, machine_kind::SINK, 3, 0);
    let (src_b_h, src_b) = place(&mut session, machine_kind::SOURCE, 0, 2);
    let (sink_b_h, _) = place(&mut session, machine_kind::SINK, 3, 2);
    // Chain A on row 0: src_a Out (facing (1,0)) -> belt (1,0)-(2,0) -> sink_a In (facing (2,0)).
    connect(&mut session, src_a_h, sink_a_h, &[(1, 0), (2, 0)]);
    // Chain B on row 2: src_b Out (facing (1,2)) -> belt (1,2)-(2,2) -> sink_b In (facing (2,2)).
    connect(&mut session, src_b_h, sink_b_h, &[(1, 2), (2, 2)]);
    (session, src_a, src_b)
}

/// The load-bearing contract: a live session that applies edits, pumps a same-tick
/// `ManualInject` batch, and advances idle settle ticks is reproduced BYTE-IDENTICALLY
/// by `replay_two_logs(seed, edit_log, event_log)` advanced the same number of idle
/// ticks. Proves `pump`'s W3 tick-stamping regroups the events at the identical tick on
/// replay (Pitfall 2 / threat T-13-01).
#[test]
fn two_log_replay_byte_identical_to_live() {
    let (mut live, src_a, src_b) = build_two_chains();

    // Pump a SAME-TICK batch: one item per source. pump stamps both at core.tick with a
    // monotonic event-sequence and folds them EDITS-FIRST in one tick.
    let stamped = live.pump(&[
        inject(src_a, Item(vec![0xA1])),
        inject(src_b, Item(vec![0xB2])),
    ]);
    assert_eq!(stamped.len(), 2, "pump returns the two just-stamped events");
    let tick_at_pump = stamped[0].tick;
    assert_eq!(
        stamped.iter().map(|e| e.tick).collect::<Vec<_>>(),
        vec![tick_at_pump, tick_at_pump],
        "pump stamps the whole batch at the SAME tick (= core.tick before the fold)",
    );
    assert_eq!(
        stamped.iter().map(|e| e.sequence).collect::<Vec<_>>(),
        vec![0, 1],
        "pump assigns a monotonic event-sequence (own sequence space)",
    );
    assert!(
        stamped.iter().all(|e| e.partition == 0),
        "pump stamps partition 0 (single-partition mode)",
    );

    // Settle the wire-minted belts.
    live.advance(SETTLE);

    // Rebuild from genesis through the two-log fold, then settle the SAME idle span.
    let mut replay = GridSession::replay_two_logs(SEED, live.edit_log(), live.event_log());
    replay.advance(SETTLE);

    assert_eq!(
        snapshot(replay.core()),
        snapshot(live.core()),
        "two-log replay reproduces the live core BYTE-IDENTICALLY (W3 tick-stamping)",
    );
}

/// Regression guard: with NO pumped events, `replay_two_logs(seed, edits, &[])` is
/// byte-identical to BOTH the live edits-only session and to `replay(seed, edits)` —
/// proving the two-log path degenerates exactly to the edits-only path when the second
/// log is empty (additive, no behaviour change to `replay`).
#[test]
fn event_free_two_log_replay_equals_single_log_replay() {
    let (live, _src_a, _src_b) = build_two_chains();

    let two_log = GridSession::replay_two_logs(SEED, live.edit_log(), &[]);
    let single_log = GridSession::replay(SEED, live.edit_log());

    let live_snap = snapshot(live.core());
    assert_eq!(
        snapshot(two_log.core()),
        live_snap,
        "event-free two-log replay is byte-identical to the live edits-only session",
    );
    assert_eq!(
        snapshot(two_log.core()),
        snapshot(single_log.core()),
        "replay_two_logs(seed, edits, &[]) == replay(seed, edits) (empty second log)",
    );
    assert!(
        live.event_log().is_empty(),
        "a session that never pumped has an empty event-log",
    );
}

/// WR-13-01 guard: `pump(&[])` is a NO-OP — it advances NO tick and logs nothing, so it
/// can never inject an UNLOGGED idle tick that `replay_two_logs` would fail to reproduce
/// (which would diverge replay from live). Deliberate idle ticks are `advance(n)`, driven
/// symmetrically on both sessions; `pump` is strictly log-driven.
#[test]
fn empty_pump_is_a_noop() {
    let (mut live, _src_a, _src_b) = build_two_chains();
    let tick_before = live.core().tick;
    let log_len_before = live.event_log().len();
    let snap_before = snapshot(live.core());

    let stamped = live.pump(&[]);
    assert!(stamped.is_empty(), "an empty pump returns no stamped events");
    assert_eq!(live.core().tick, tick_before, "empty pump advances NO tick");
    assert_eq!(
        live.event_log().len(),
        log_len_before,
        "empty pump appends nothing to the event-log",
    );
    assert_eq!(
        snapshot(live.core()),
        snap_before,
        "empty pump leaves the core BYTE-IDENTICAL (a true no-op)",
    );

    // The empty pump did not desync live from its two-log replay image.
    let replay = GridSession::replay_two_logs(SEED, live.edit_log(), live.event_log());
    assert_eq!(
        snapshot(replay.core()),
        snapshot(live.core()),
        "after an empty pump, replay_two_logs is still byte-identical to live",
    );
}
