//! Phase 68-03 (BELT-03, SC3): BELT BACKPRESSURE, in the only non-frozen home it can
//! have, and the rescue of the tree's only belt-bunching assertion.
//!
//! # THIS FILE CARRIES NO `#![cfg]` OF ANY KIND, AND THAT IS ITS MOST IMPORTANT PROPERTY
//! The assertions rescued here came from the development-pace board's own spec, a file
//! gated WHOLE-FILE behind a non-default cargo feature and therefore reporting
//! `running 0 tests` on a bare `cargo test`. That file's own header recorded what the
//! gate cost: *"A test this file's own header excused from the sweep is a test nothing
//! measures, and the failure below sat unseen for the rest of the phase because of it."*
//! The hole was closed in 2026-08-15 by teaching the red-set gate to pass
//! `--all-features`. **That repair does not transfer, and it no longer has anything to
//! transfer to.** Plan 68-07 DELETED that feature and that file outright (`68-CONTEXT.md`
//! D-68-12; the file is named in `68-03-SUMMARY.md` and `68-07-SUMMARY.md`), so there is
//! now no `--all-features` run that could reveal the same mistake here - the feature does
//! not exist to be enabled. A conditional-compilation attribute added to this file would
//! be permanently invisible. There is none, an acceptance criterion greps for it, and the
//! `running N tests` count is read by name and recorded in `68-03-SUMMARY.md`.
//!
//! # TWO DIFFERENT BUNCHING CASES FROM THE SAME FOLD LIVE HERE. ONLY ONE IS SC3's.
//! `crates/fabrico-core/src/tick.rs:838-856` states three downstream cases for a belt's
//! occupied head, and this file exercises two of them:
//!
//!   * **The DANGLING-HEAD retain** (`tick.rs:853-854`, "NO downstream link -> RETAIN the
//!     head in slot 0"). This is the case rescued from that deleted spec. A belt
//!     with nothing docked to its head can never deliver, so it saturates. **Its pace is
//!     irrelevant**: a belt at any interval bunches against a dangling head.
//!   * **The BELT-TO-BELT FULL-TAIL retain** (`tick.rs:844-848`, "on a FULL tail RETAIN
//!     the head in slot 0 (bunch) and consume NO `route_seq` ... a blocked/full tail belt
//!     makes its upstream bunch tile-by-tile from the head end (never drops, BELT-08)").
//!     **THIS ONE IS SC3's**, by `68-CONTEXT.md` D-68-09, and here the pace difference is
//!     the whole cause: the negative controls below show the upstream head is never
//!     sustained-retained when the two runs share a pace, at either speed.
//!
//! A reader who conflates the two will think SC3 is covered by the rescued test alone. It
//! is not: the rescued test would pass unchanged on a board where per-belt pace did not
//! exist.
//!
//! # MEASURED DEVIATION: THE BELT-TO-BELT JUNCTION IS NOT USER-CONSTRUCTIBLE IN v8.0
//! D-68-09 rules that SC3 ships on the belt-to-belt backpressure that already exists. That
//! behaviour is real and it is asserted below. **It is also unreachable from the certified
//! command path**, and that was measured rather than assumed:
//!
//!   * `GridCommand::Dock { belt, endpoint: Head, node: <another belt's handle>, port: 0 }`
//!     was refused with `CommandError::InvalidDock`, because a belt declared no ports for
//!     the Dock arm to resolve. There is a live test for it at the bottom of this file, so
//!     the claim keeps a check rather than living in a comment.
//!
//!     **THAT PARAGRAPH IS HISTORY AS OF PHASE 74** (LINK-08, D-04), and it is corrected
//!     in place rather than deleted so the reversal stays readable. A belt is now a ported
//!     node: its Tail is a `Role::In` record and its Head a `Role::Out` record in the same
//!     `GridState.ports` map machine ports live in, the belt-to-belt dock is judged by the
//!     same adjacency, facing and role rule in the same validate arm, and the test at the
//!     bottom of this file is INVERTED rather than removed - it asserts the accept now.
//!     `a_user_joins_two_belt_runs_into_one` carries the whole slice, from the two stored
//!     Port records through the accepted `Dock` to the render packet naming the join from
//!     both sides.
//!   * A MACHINE junction is no longer the ONLY one a user can build, but it is still one
//!     they can, and **the upstream belt BUNCHES against it**. That is the reverse of what this file recorded through
//!     v8.0 and it is the whole of D-68-10, closed by phase 71 in two halves:
//!     `admit::MECHANICAL_INBOX_CAP` bounds every machine inbox (PILE-01, plan 71-01), and
//!     the fold's `outputs_blocked` gate stops a machine consuming while its own output
//!     is refused (PILE-02, plan 71-03). Measured on the `08-belt-speed-meet` topology
//!     (SOURCE -> fast belt -> MERGE -> slow belt): the slow belt saturates, the MERGE is
//!     gated, and the fast belt packs FULL with the tile touching the junction occupied.
//!     Nothing is dropped and the backlog a player expects to see piled on the fast belt
//!     is piled on the fast belt.
//!     Through v8.0 the record here read the other way, and it is worth keeping the shape
//!     of it: the fast belt drained completely to EMPTY and the surplus queued in the
//!     DOWNSTREAM BELT's inbox, which nothing draws. The assertions below are the running
//!     record of the change, in both directions.
//!
//! So the junction link in the SC3 cases is made at the CORE SEAM
//! (`Host::core_mut().state.link((upstream, 0), (downstream, 0))`), the same seam
//! `tick.rs`'s own `tick_belt_to_belt_bunches_on_full_downstream_tail` uses. **The PACES
//! are still set through logged `GridCommand::Configure` commands**, because the pace is
//! the thing this phase ships and the certified path is the one that will exist after it;
//! only the junction edge, which no gesture can produce, is reached into directly. That
//! asymmetry is deliberate and it is the honest one: a test that set the pace by hand
//! would be satisfied by an engine that ignored every command sent to it.
//!
//! # THE FROZEN CORPUS IS CITED AS EVIDENCE AND NOT EDITED
//! `crates/fabrico-scenario` is entry 3 of the core-freeze gate's `FROZEN_PATHS`
//! and **the freeze covers `tests/` as surely as `fixtures/`**, so neither a new scene nor
//! an assertion added to an existing one is available to this phase. Two fixtures are
//! nonetheless load-bearing evidence:
//!
//!   * `06-belt-speed` already drives two runs at `ticks_per_slot` 3 and 9 into a shared
//!     offload and already ASSERTS the backlog (the fast run has cleared while the slow
//!     one is still carrying). Those assertions RUN today: `bless_fixtures` is `#[ignore]`
//!     but `fixtures_are_deterministic` is not, and it calls every authoring function. The
//!     two-speed half of SC3 is cited here, not rebuilt.
//!   * `08-belt-speed-meet` pins the junction BYTES and deliberately asserts nothing about
//!     them, so that a fixture could not settle this milestone's human gate by accident.
//!     That is the assertion this file owes.
//!
//! # WHAT THIS FILE DOES ASSERT THAT IT ONCE REFUSED TO, AND WHY
//! **Machine-side item piling.** This section used to say the opposite: that a machine
//! inbox was unbounded by design so a belt->machine link NEVER bunched, that bounding it
//! meant editing frozen `state.rs` and `tick.rs`, and that nothing green here was
//! evidence for a claim about a machine holding a queue. `68-CONTEXT.md` D-68-10 made it
//! the opening keystone of v9.0 rather than backlog, and phase 71 spent it. A machine
//! inbox is now bounded by `admit::MECHANICAL_INBOX_CAP` and a machine whose output is
//! refused is not stepped at all, so the assertions below ARE evidence for exactly that
//! claim. The frozen-source note stands corrected too: `crates/fabrico-core` is edited
//! under phase 70's declared-moves gate rather than frozen against all change.

use fabrico_command::CommandError;
use fabrico_core::admit::{MECHANICAL_INBOX_CAP, SOURCE_PENDING_CAP};
use fabrico_core::belt_slots::DEFAULT_TICKS_PER_SLOT;
use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::fault::{Fault, FaultReason, FAULT_PORT};
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::persist::RedbStore;
use fabrico_core::state::Node;
use fabrico_host::driver::Host;
use fabrico_host::input_apply::apply_gesture;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::render_packet::RenderPacketBuilder;
use fabrico_protocol::{BeltEnd, GridCommand, MachineConfig, machine_kind};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

// =================================================================================
// The rig - re-homed from the deleted development-pace board spec, with its constants
// deliberately left behind
// =================================================================================

/// A board on a real `Host` over tempfile redb stores, plus the dense-handle table the
/// gesture frames address it by (the handle IS the index into `nodes`).
///
/// # Which technique was copied and which constants were NOT
/// The SHAPE is the deleted spec's `seeded_board()` at its `:198-227`: seed onto a real
/// `Host` through the certified one-command-per-tick gesture path, never by reaching into
/// core state to mint nodes. Its **contents** were deliberately not copied. That
/// `seeded_board()` read the dev board's command list and its genesis-seed constant out of
/// `fabrico_host::demo_scene`, and plan 68-07 deleted both along with the feature they
/// belonged to, so a verbatim copy would have compiled at 68-03 and stopped compiling one
/// plan later, in the exact window where nothing is watching this coverage. Every command
/// here is authored in this file, which is why this file still compiles and still counts.
///
/// The original's timer contract is preserved in spirit: it installs its scene timers
/// STRICTLY AFTER seeding, because a pre-installed timer fires during the seed ticks and
/// injects into a half-built grid. This rig needs no timers at all: items are pushed as
/// explicit `ManualInject` ingress events at ticks this file chooses, which removes that
/// hazard rather than re-implementing the guard against it.
struct Board {
    _dir: tempfile::TempDir,
    host: Host,
    ingress_tx: UnboundedSender<EventPayload>,
    ingress_rx: UnboundedReceiver<EventPayload>,
    cmd_tx: UnboundedSender<Command>,
    cmd_rx: UnboundedReceiver<Command>,
    results_rx: UnboundedReceiver<ResultEvent>,
    nodes: Vec<NodeId>,
}

impl Board {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: 7,
        });
        let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
        let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
        let host = Host::new(core, store, ledger, None).expect("open host");
        let (ingress_tx, ingress_rx) = unbounded_channel();
        let (cmd_tx, cmd_rx) = unbounded_channel();
        let (_res_tx, results_rx) = unbounded_channel();
        Self {
            _dir: dir,
            host,
            ingress_tx,
            ingress_rx,
            cmd_tx,
            cmd_rx,
            results_rx,
            nodes: Vec::new(),
        }
    }

    fn tick(&mut self) {
        self.host
            .tick_once(&mut self.ingress_rx, &mut self.results_rx, &self.cmd_tx)
            .expect("tick persists");
    }

    /// Apply ONE `GridCommand` through the certified gesture path and fold it in ONE tick.
    ///
    /// One command per tick is structural, not stylistic: a `Dock` resolves its target
    /// against the LIVE core, so each dependency must be folded a tick before its
    /// dependent.
    fn apply(&mut self, cmd: GridCommand, what: &str) {
        let table = self.nodes.clone();
        apply_gesture(&mut self.host, cmd, move |h| table.get(h as usize).copied())
            .unwrap_or_else(|e| panic!("{what}: rejected with {e:?}"));
        self.tick();
        let placed: Vec<NodeId> = self.host.core().last_tick.placed.to_vec();
        self.nodes.extend(placed);
    }

    /// Apply a gesture WITHOUT folding it, returning the command layer's typed verdict.
    fn try_apply(&mut self, cmd: GridCommand) -> Result<(), CommandError> {
        let table = self.nodes.clone();
        apply_gesture(&mut self.host, cmd, move |h| table.get(h as usize).copied())
    }

    /// Queue one `ManualInject` of `item` into `target` on port 0: the ingress payload
    /// shape the webhook and timer sources produce; the host stamps tick and sequence.
    fn inject(&mut self, target: NodeId, item: &[u8]) {
        self.ingress_tx
            .send(EventPayload::ManualInject {
                target,
                port: 0,
                item: Item(item.to_vec()),
            })
            .expect("the ingress receiver is alive for the life of the board");
    }

    /// Drain every dispatched `Command` off the live command channel and return how many.
    ///
    /// A SINK consumes one item and emits exactly one `Command` of intent, so this is the
    /// count of items that have LEFT the board, the third term in the conservation sum.
    fn drain_dispatched(&mut self) -> usize {
        let mut n = 0;
        while self.cmd_rx.try_recv().is_ok() {
            n += 1;
        }
        n
    }

    fn handle(&self, h: usize) -> NodeId {
        self.nodes[h]
    }

    /// The belt's LIVE advance interval, read off FOLDED CORE STATE rather than off the
    /// command that was sent. A test that trusts the commands it sent is satisfied by an
    /// engine that ignored them.
    fn pace_of(&self, belt: NodeId) -> u32 {
        match self.host.core().state.node(belt) {
            Some(Node::Belt(b)) => b.ticks_per_slot.get(),
            other => panic!("{belt:?} is not a live belt: {other:?}"),
        }
    }
}

/// A belt's slot occupancy in the core's own index order.
///
/// **Index 0 is the HEAD (the deliver end) and `len - 1` is the TAIL (the admit end)**.
/// `Belt::step` admits into `slots[m - 1]`, so a jam against a blocked head is a
/// contiguous run of occupied slots starting at index 0. Read off the primitive rather
/// than assumed: an inverted reading here would have made every bunching assertion in this
/// file pass on a belt that was filling from the wrong end. That is not a hypothetical
/// worry: it is `T-68-03-02` in the plan's threat register, and
/// [`slot_occupancy_reads_index_zero_as_the_deliver_end`] is the positive control that
/// keeps it honest.
fn slot_occupancy(host: &Host, belt: NodeId) -> Vec<bool> {
    match host.core().state.node(belt) {
        Some(Node::Belt(b)) => b.slots.iter().map(Option::is_some).collect(),
        other => panic!("handle {belt:?} is not a belt: {other:?}"),
    }
}

/// Index 0 is the HEAD (the deliver end). See [`slot_occupancy`].
const HEAD: usize = 0;

/// Occupied slots, total.
fn filled(occ: &[bool]) -> usize {
    occ.iter().filter(|o| **o).count()
}

/// The GAP-FREE occupied run measured FROM THE HEAD (index 0): the bunch.
///
/// This is deliberately not the same number as [`filled`]. A belt merely CARRYING items
/// has occupancy scattered along its length and a head-anchored prefix of zero; a belt
/// that has bunched against a blocked head has the two numbers equal. Every "it bunched"
/// claim in this file is about THIS measure.
fn head_prefix(occ: &[bool]) -> usize {
    occ.iter().take_while(|o| **o).count()
}

fn tick_n(board: &mut Board, n: usize) {
    for _ in 0..n {
        board.tick();
    }
}

// =================================================================================
// RESCUED FROM THE DELETED DEV-PACE BOARD SPEC: the dangling-head retain
// (`tick.rs:853-854`)
// =================================================================================

/// The rescued board: a SOURCE feeding one belt whose HEAD IS UNDOCKED.
///
/// That omission IS the stall. The deleted spec proved the same property on the dev-only
/// board, which had a whole second belt and two scene timers in it; none of that is
/// load-bearing for the claim, so none of it was copied.
fn dangling_head_board() -> (Board, NodeId, NodeId) {
    let mut b = Board::new();
    // SOURCE @ (0,0): Out = own cell, faces E, so the belt TAIL sits one step E at (1,0).
    b.apply(
        GridCommand::Place {
            kind: machine_kind::SOURCE,
            cell_x: 0,
            cell_y: 0,
        },
        "place SOURCE",
    );
    // Drawn TAIL-first: (1,0) is the tail, (4,0) is the head, and nothing is placed beyond
    // it. 4 tiles = 16 slots at the locked SLOTS_PER_TILE of 4.
    b.apply(
        GridCommand::DrawBelt {
            cells: vec![(1, 0), (2, 0), (3, 0), (4, 0)],
        },
        "draw the stalled belt",
    );
    b.apply(
        GridCommand::Dock {
            belt: 1,
            endpoint: BeltEnd::Tail,
            node: 0,
            port: 0,
        },
        "dock the belt TAIL to the SOURCE Out",
    );
    let source = b.handle(0);
    let belt = b.handle(1);
    (b, source, belt)
}

#[test]
fn the_stalled_belt_retains_its_head_on_every_tick_of_the_window() {
    let (mut b, source, belt) = dangling_head_board();

    // EVERY TICK COUNT BELOW IS A BUDGET AND EVERY BUDGET IS DERIVED FROM THE BELT'S OWN
    // INTERVAL, read off folded core state. Plan 62-03's rule, carried across with the
    // assertions it protects: budgets are headroom and must stretch with the advance
    // interval; EXPECTATIONS are hand-pinned, because a value derived from the constant
    // under test agrees with it at every value. Nothing this test ASSERTS is computed from
    // `interval`.
    let interval = u64::from(b.pace_of(belt));
    assert_eq!(
        interval,
        u64::from(DEFAULT_TICKS_PER_SLOT.get()),
        "the rescued board runs at the construction default; no Configure was sent",
    );
    let slots = slot_occupancy(&b.host, belt).len();

    // Enough items to overflow the belt outright, pushed in one ingress batch. The
    // original found its arrival tick by OBSERVATION rather than by ticking to a number,
    // after a flat `50` landed on a board that had not begun to bunch when the advance
    // interval moved off 1. That correction is kept.
    for i in 0..(slots as u8 + 8) {
        b.inject(source, &[i]);
    }

    let arrival_budget = 2 * (slots as u64) * interval;
    let mut arrived_at: Option<u64> = None;
    for t in 1..=arrival_budget {
        tick_n(&mut b, 1);
        if slot_occupancy(&b.host, belt)[HEAD] {
            arrived_at = Some(t);
            break;
        }
    }
    let arrived_at = arrived_at.unwrap_or_else(|| {
        panic!(
            "the HEAD slot must become occupied within the budget: the head has nothing \
             docked to it, so an item that reaches it can never be delivered and RETAINS. \
             It never arrived in {arrival_budget} ticks ({slots} slots at {interval} \
             tick(s) per slot, doubled as headroom). Occupancy: {:?}",
            slot_occupancy(&b.host, belt)
        )
    });

    // The head does not clear on ANY later tick. Checked EVERY TICK rather than at the
    // window's endpoint, which is the clause that actually bites: a belt that delivered
    // would show a cleared head on some tick in between and an endpoint sample can miss it
    // entirely.
    let hold_budget = 40 * interval;
    for t in 1..=hold_budget {
        tick_n(&mut b, 1);
        let occ = slot_occupancy(&b.host, belt);
        assert!(
            occ[HEAD],
            "the head slot must STAY occupied - an undeliverable head never clears - but \
             it was empty {t} tick(s) after it first filled (tick {arrived_at} of the \
             run). Occupancy: {occ:?}"
        );
    }

    // The queue BUILT, and it is a HEAD-ANCHORED GAP-FREE bunch rather than scattered
    // occupancy. Stated as a hand-pinned floor against the belt's own length: 30 of 40
    // was the original's floor on a 10-tile belt, which is three quarters of it.
    let later = slot_occupancy(&b.host, belt);
    let floor = slots * 3 / 4;
    assert!(
        head_prefix(&later) >= floor,
        "the belt must BUNCH tile-by-tile FROM the blocked head: at least {floor} of its \
         {slots} slots must form a GAP-FREE run starting at index 0, and only \
         {} do. Occupancy: {later:?}",
        head_prefix(&later)
    );

    // And it stays that way for as long as the sitting lasts: a belt that un-jammed on its
    // own would put a moving item on screen at the one place a stalled board exists to
    // show as motionless. BUDGET, on plan 62-03's `SETTLE` shape (`64 * interval` in
    // `bless_fixtures.rs`): the literal is the multiplier, the interval is the unit.
    let settle_budget = 400 * interval;
    tick_n(&mut b, settle_budget as usize);
    let settled = slot_occupancy(&b.host, belt);
    assert!(
        settled.iter().all(|o| *o),
        "{settle_budget} further ticks against a blocked head must leave the belt FULL, \
         tail to head. Occupancy: {settled:?}"
    );
}

#[test]
fn the_queue_behind_a_dangling_head_never_drains() {
    // The never-drop half, kept as its own case rather than folded into the sibling.
    // BELT-08's guarantee is that nothing is DROPPED, and a retention test that does not
    // count items cannot see it however green it is.
    let (mut b, source, belt) = dangling_head_board();
    let interval = u64::from(b.pace_of(belt));
    let slots = slot_occupancy(&b.host, belt).len();
    let injected = slots + 8;
    for i in 0..(injected as u8) {
        b.inject(source, &[i]);
    }

    // A RUNNING LOW-WATER MARK checked on EVERY tick of the window, never a pair of
    // endpoint samples: a belt that drained and refilled between two samples reads
    // identical at both.
    let window = (2 * (slots as u64) + 40) * interval;
    let mut low_water = 0usize;
    let mut peak = 0usize;
    for t in 1..=window {
        tick_n(&mut b, 1);
        let occ = slot_occupancy(&b.host, belt);
        let now = filled(&occ);
        assert!(
            now >= low_water,
            "the queue against a blocked head must never DRAIN, but the occupied count \
             fell from {low_water} to {now} on tick {t} of the window. Occupancy: {occ:?}"
        );
        low_water = now;
        peak = peak.max(now);
    }
    assert_eq!(
        peak, slots,
        "the belt must have saturated inside the window, or 'never decreased' is a claim \
         about a belt that never filled"
    );
}

#[test]
fn slot_occupancy_reads_index_zero_as_the_deliver_end() {
    // THE POSITIVE CONTROL ON THE INSTRUMENT (T-68-03-02). `slot_occupancy` is the single
    // lens every claim in this file reads through, and an INVERTED lens makes a belt
    // filling from the wrong end look like a bunch forming at the right one. There is no
    // second reading to catch that, so the direction is asserted here against a FLOWING
    // belt before any bunching claim rests on it.
    //
    // The reading: put exactly ONE item on a belt that delivers, and follow the index of
    // the occupied slot. It must START at `len - 1` (the tail, the admit end) and DECREASE
    // monotonically toward index 0 (the head, the deliver end) before the item leaves.
    // Under an inverted `slot_occupancy` the observed index would start at 0 and increase,
    // and every "bunches from the head end" assertion below would then be satisfied by a
    // belt packing against its TAIL.
    //
    // MEASURED, AND WORTH RECORDING BECAUSE IT IS THE WHOLE REASON AN OCCUPIED HEAD MEANS
    // SOMETHING: on a DELIVERING belt index 0 is never OBSERVED occupied at a tick
    // boundary. Head delivery is ungated in the fold (`tick.rs:838-856` runs after
    // `Belt::step`), so the item that advances into slot 0 is delivered on that same tick
    // and the trace runs `len-1 .. 1` and then empty. Slot 0 being occupied at a tick
    // boundary IS the retain, which is exactly what the bunching cases assert.
    let mut b = Board::new();
    b.apply(
        GridCommand::Place {
            kind: machine_kind::SOURCE,
            cell_x: 0,
            cell_y: 0,
        },
        "place SOURCE",
    );
    // SINK @ (6,0): In = own cell, faces W, so the belt HEAD sits one step W at (5,0).
    b.apply(
        GridCommand::Place {
            kind: machine_kind::SINK,
            cell_x: 6,
            cell_y: 0,
        },
        "place SINK",
    );
    b.apply(
        GridCommand::DrawBelt {
            cells: vec![(1, 0), (2, 0), (3, 0), (4, 0), (5, 0)],
        },
        "draw the flowing belt",
    );
    b.apply(
        GridCommand::Dock {
            belt: 2,
            endpoint: BeltEnd::Tail,
            node: 0,
            port: 0,
        },
        "dock TAIL to SOURCE Out",
    );
    b.apply(
        GridCommand::Dock {
            belt: 2,
            endpoint: BeltEnd::Head,
            node: 1,
            port: 0,
        },
        "dock HEAD to SINK In",
    );
    let source = b.handle(0);
    let belt = b.handle(2);

    let interval = u64::from(b.pace_of(belt));
    let slots = slot_occupancy(&b.host, belt).len();
    b.inject(source, b"one");

    let mut seen: Vec<usize> = Vec::new();
    let budget = (2 * slots as u64 + 8) * interval;
    for _ in 0..budget {
        tick_n(&mut b, 1);
        let occ = slot_occupancy(&b.host, belt);
        assert!(
            filled(&occ) <= 1,
            "exactly one item was injected, so at most one slot can ever be occupied; \
             {occ:?} says otherwise and the instrument cannot be trusted"
        );
        if let Some(i) = occ.iter().position(|o| *o) {
            if seen.last() != Some(&i) {
                seen.push(i);
            }
        } else if !seen.is_empty() {
            break;
        }
    }

    assert_eq!(
        seen.first().copied(),
        Some(slots - 1),
        "the item must be ADMITTED at index {} (the TAIL). It was first seen at {:?}. If \
         it was first seen at index 0, `slot_occupancy` is INVERTED - and an inverted \
         reading would make every 'bunches from the head end' assertion in this file pass \
         on a belt packing against its tail. Index trace: {seen:?}",
        slots - 1,
        seen.first(),
    );
    assert!(
        seen.windows(2).all(|w| w[1] < w[0]),
        "the occupied index must DECREASE monotonically from tail to head - that is what \
         'index 0 is the deliver end' means. Index trace: {seen:?}"
    );
    assert!(
        seen.last().copied().is_some_and(|last| last <= HEAD + 1),
        "the item must LEAVE the belt at the LOW-index end (index 0 or the slot above it, \
         since head delivery is ungated and slot 0 is not observed at a tick boundary on a \
         delivering belt). It was last seen at {:?}, which is the WRONG END of the belt: \
         under an inverted `slot_occupancy` the trace would run 0 upward and exit at \
         {}. Index trace: {seen:?}",
        seen.last(),
        slots - 1,
    );
    assert!(
        slot_occupancy(&b.host, belt).iter().all(|o| !*o),
        "the item left the belt, so the belt is empty",
    );
    assert_eq!(
        b.drain_dispatched(),
        1,
        "and it left INTO THE SINK: exactly one Command of intent was dispatched for the \
         one item injected. Conservation, not just disappearance",
    );
}

// =================================================================================
// SC3 - the MEET: a fast run feeding a slow one (`tick.rs:844-848`)
// =================================================================================

/// The FAST side of the junction: `2`, which is both the construction default and the
/// FASTEST value `68-CONTEXT.md` D-68-01 lets a user choose (`ticks_per_slot` 2..=20,
/// slower-only, the default at the fast end).
///
/// # Why this pair, and why it is inside the bound
/// Far enough apart to be legible inside a tick budget, which is the same reasoning
/// `06-belt-speed` records for its own 3-and-9: a ratio of ten means the downstream frees
/// its tail once for every ten advances of the upstream, so the backlog is a sustained
/// state rather than a rounding difference. **BOTH VALUES LIE INSIDE `2..=20`** and that is
/// load-bearing, not incidental: plan 68-04 lands one wave later and makes `2..=20` a
/// WRITE-side bound on the very `Configure` path these paces are set through (D-68-01,
/// D-68-02). A pair chosen for legibility alone (2 and 30, say) would pass in this wave
/// and redden in the next, and the failure would be attributed to the new bound rather
/// than to this board.
const MEET_FAST_TICKS_PER_SLOT: u32 = 2;
/// The SLOW side of the junction: `20`, the SLOWEST value D-68-01 lets a user choose. Ten
/// times [`MEET_FAST_TICKS_PER_SLOT`]. See that constant for the full reasoning.
const MEET_SLOW_TICKS_PER_SLOT: u32 = 20;

/// Items pushed onto the upstream run, one every [`MEET_INJECT_EVERY`] ticks.
const MEET_ITEMS: usize = 8;
/// Ticks between injections.
///
/// DERIVED, and the derivation is the point of the test that reads it. At
/// [`MEET_FAST_TICKS_PER_SLOT`] the upstream advances one slot every 2 ticks, so a 7-tick
/// gap leaves roughly three empty slots between consecutive items. They therefore arrive
/// at the blocked head ONE AT A TIME and the bunch forms TILE BY TILE, which is the
/// behaviour `tick.rs:844-848` describes in those words. Injecting the whole batch at once
/// instead packs the belt solid from the tail before the head is ever reached, and the
/// head-anchored prefix then jumps 0 -> full in a single tick, a board on which "the
/// bunch grows from the head end" is unobservable however true it is.
const MEET_INJECT_EVERY: usize = 7;
/// The measured window, in ticks. Long enough to contain several whole slow-side intervals
/// (7 of them at [`MEET_SLOW_TICKS_PER_SLOT`]) so a sustained retention is distinguishable
/// from a single blocked tick, and long enough for all [`MEET_ITEMS`] injections plus the
/// upstream traverse. HEADROOM, never an expectation: nothing asserted below is computed
/// from it.
const MEET_WINDOW: usize = 140;

/// One tick's reading of the junction. Every assertion in the meet cases reads THIS, so
/// they all see the same board through the same instrument.
struct MeetSample {
    /// Was the upstream belt's head (slot 0) occupied at this tick boundary?
    head_held: bool,
    /// The gap-free occupied run measured FROM the upstream head: the bunch.
    prefix: usize,
    /// The upstream belt's occupancy, kept for failure messages.
    upstream: Vec<bool>,
    /// Every item on the board that has not yet left through the sink: both belts' slots
    /// plus both belts' inboxes (an item pushed by the fold sits in the destination's
    /// inbox for a tick before `Belt::step` admits it into the tail).
    resident: usize,
    /// Items that have LEFT through the sink, cumulative.
    dispatched: usize,
    /// Items injected so far, cumulative.
    injected: usize,
}

/// Items sitting in a node's inbox, counted off a CLONE so the live core is untouched.
/// How many items rest in a Source's `pending` deque - the resting place plan 71-03's
/// PILE-02 gate created.
///
/// Before the gate a source drained its whole `pending` every step, so a conservation
/// sum could ignore it. Under the gate a source whose output belt is full is not stepped
/// at all and `pending` holds, bounded by `SOURCE_PENDING_CAP` (PILE-04).
fn source_pending(host: &Host, id: NodeId) -> usize {
    match host.core().state.node(id) {
        Some(Node::Source(src)) => src.pending.len(),
        _ => 0,
    }
}

fn inbox_count(host: &Host, id: NodeId) -> usize {
    match host.core().state.inbox_of(id) {
        Some(inbox) => {
            let mut clone = inbox.clone();
            let mut n = 0;
            while clone.take(0).is_some() {
                n += 1;
            }
            n
        }
        None => 0,
    }
}

/// Items a node holds as `OutputRefused` fault payloads on its `FAULT_PORT` - the THIRD
/// resting place, and the one Phase 71 added.
///
/// A mechanical inbox is bounded by [`MECHANICAL_INBOX_CAP`] since 71-01. The fold's
/// generic outbox drain has nowhere to RETAIN a refused item, so it mints a
/// `FaultReason::OutputRefused` carrying the item's bytes (71-01 ruling R-4). Any
/// conservation count over slots and inboxes alone now under-counts by the number of
/// refusals and would read a correct refusal as a LOSS.
fn refused_on_fault_port(host: &Host, id: NodeId) -> usize {
    match host.core().state.inbox_of(id) {
        Some(inbox) => inbox
            .items_on(FAULT_PORT)
            .filter(|item| {
                matches!(Fault::decode(item), Ok(f) if f.reason == FaultReason::OutputRefused)
            })
            .count(),
        None => 0,
    }
}

/// Build the meet board and drive it for [`MEET_WINDOW`] ticks, returning one
/// [`MeetSample`] per tick.
///
/// # The board
/// `SOURCE -> upstream belt -> [junction] -> downstream belt -> SINK`. The downstream run
/// DELIVERS into a sink rather than dangling, and that choice is what makes the case about
/// SPEED at all: against a dangling head a downstream belt saturates permanently and its
/// upstream bunches at any pace, so the equal-pace control would stay green and the test
/// would prove nothing about `ticks_per_slot`. With the sink attached, the downstream's
/// tail frees once every `down_pace` ticks and the upstream's retention is a direct
/// consequence of the ratio between the two paces.
///
/// # The one edge reached in at the core seam, and why it is KEPT there
/// `[junction]` is `link((upstream, 0), (downstream, 0))`, written through
/// `Host::core_mut()`. When these cases were authored no `GridCommand` could produce that
/// link at all; since Phase 74 one can, and
/// [`a_user_can_now_build_the_belt_to_belt_junction_and_the_machine_one_still_bunches`]
/// asserts the accept rather than leaving it in prose. The seam write stays here anyway,
/// deliberately: these cases are about the FOLD's belt-to-belt retain, and rebuilding
/// their board through the certified path would silently re-scope them onto the accept
/// envelope as well. Everything else on this board, INCLUDING BOTH PACES, goes through the
/// certified gesture path.
fn drive_meet(up_pace: u32, down_pace: u32) -> Vec<MeetSample> {
    let mut b = Board::new();
    b.apply(
        GridCommand::Place {
            kind: machine_kind::SOURCE,
            cell_x: 0,
            cell_y: 0,
        },
        "place SOURCE",
    );
    // SINK @ (11,0): In = own cell, faces W, so the downstream HEAD sits at (10,0).
    b.apply(
        GridCommand::Place {
            kind: machine_kind::SINK,
            cell_x: 11,
            cell_y: 0,
        },
        "place SINK",
    );
    // The upstream run: 4 tiles = 16 slots. Tail docked to the source; head UNDOCKED,
    // because this board's junction is written at the core seam below (see this function's
    // docblock) rather than through the certified path.
    b.apply(
        GridCommand::DrawBelt {
            cells: vec![(1, 0), (2, 0), (3, 0), (4, 0)],
        },
        "draw the UPSTREAM run",
    );
    b.apply(
        GridCommand::Dock {
            belt: 2,
            endpoint: BeltEnd::Tail,
            node: 0,
            port: 0,
        },
        "dock the upstream TAIL to the SOURCE Out",
    );
    // The downstream run: 5 tiles = 20 slots. Head docked to the sink; tail UNDOCKED, for
    // the same reason.
    b.apply(
        GridCommand::DrawBelt {
            cells: vec![(6, 0), (7, 0), (8, 0), (9, 0), (10, 0)],
        },
        "draw the DOWNSTREAM run",
    );
    b.apply(
        GridCommand::Dock {
            belt: 3,
            endpoint: BeltEnd::Head,
            node: 1,
            port: 0,
        },
        "dock the downstream HEAD to the SINK In",
    );
    // BOTH PACES THROUGH LOGGED `Configure` COMMANDS. Never a write into core state: the
    // point of SC3 is a board a user could build, and a test that set `ticks_per_slot` by
    // hand would be satisfied by an engine that ignored every command sent to it.
    b.apply(
        GridCommand::Configure {
            node: 2,
            config: MachineConfig::Belt {
                ticks_per_slot: up_pace,
            },
        },
        "configure the UPSTREAM pace",
    );
    b.apply(
        GridCommand::Configure {
            node: 3,
            config: MachineConfig::Belt {
                ticks_per_slot: down_pace,
            },
        },
        "configure the DOWNSTREAM pace",
    );

    let source = b.handle(0);
    let upstream = b.handle(2);
    let downstream = b.handle(3);
    b.host.core_mut().state.link((upstream, 0), (downstream, 0));

    let mut out: Vec<MeetSample> = Vec::with_capacity(MEET_WINDOW);
    let mut dispatched = 0usize;
    let mut injected = 0usize;
    for t in 0..MEET_WINDOW {
        if t % MEET_INJECT_EVERY == 0 && t / MEET_INJECT_EVERY < MEET_ITEMS {
            b.inject(source, &[(t / MEET_INJECT_EVERY) as u8]);
            injected += 1;
        }
        b.tick();
        dispatched += b.drain_dispatched();
        let up = slot_occupancy(&b.host, upstream);
        let down = slot_occupancy(&b.host, downstream);
        out.push(MeetSample {
            head_held: up[HEAD],
            prefix: head_prefix(&up),
            resident: filled(&up)
                + filled(&down)
                + inbox_count(&b.host, upstream)
                + inbox_count(&b.host, downstream),
            upstream: up,
            dispatched,
            injected,
        });
    }
    // The paces are read back off FOLDED CORE STATE, not off the commands that were sent.
    assert_eq!(b.pace_of(upstream), up_pace, "the upstream pace folded");
    assert_eq!(b.pace_of(downstream), down_pace, "the downstream pace folded");
    out
}

/// The LONGEST run of consecutive ticks on which the upstream head was held, as
/// `(start index, length)`. Scans EVERY tick in the window: the retention claim is about
/// what happened on every tick, not about a sampled pair of them.
fn longest_retention(samples: &[MeetSample]) -> (usize, usize) {
    let (mut best_start, mut best_len) = (0usize, 0usize);
    let (mut cur_start, mut cur_len) = (0usize, 0usize);
    for (i, s) in samples.iter().enumerate() {
        if s.head_held {
            if cur_len == 0 {
                cur_start = i;
            }
            cur_len += 1;
            if cur_len > best_len {
                best_start = cur_start;
                best_len = cur_len;
            }
        } else {
            cur_len = 0;
        }
    }
    (best_start, best_len)
}

#[test]
fn a_fast_run_feeding_a_slow_one_retains_its_head_across_the_slow_interval() {
    // SC3's meet, and the assertion D-68-09 rules is its answer. The claim is not "the
    // upstream is carrying items" - any board where transport is happening at all
    // satisfies that, including one where both runs share a pace. The claim is that the
    // upstream head is UNDELIVERABLE for a SUSTAINED stretch, and the stretch's length is
    // DERIVED from the downstream's interval rather than tuned: a downstream belt at
    // `ticks_per_slot = n` advances (and so frees its tail) on one tick in every `n`, so
    // the upstream head has nowhere to go on the other `n - 1`.
    let samples = drive_meet(MEET_FAST_TICKS_PER_SLOT, MEET_SLOW_TICKS_PER_SLOT);
    let floor = (MEET_SLOW_TICKS_PER_SLOT - 1) as usize;
    let (start, len) = longest_retention(&samples);
    assert!(
        len >= floor,
        "a fast run feeding a slow one must RETAIN its head for at least {floor} \
         consecutive ticks - the downstream at {MEET_SLOW_TICKS_PER_SLOT} ticks per slot \
         frees its tail on one tick in {MEET_SLOW_TICKS_PER_SLOT}, so the head is \
         undeliverable on the other {floor}. The longest retention in \
         {MEET_WINDOW} ticks was {len} (from tick {start}). Upstream occupancy at the end \
         of that run: {:?}",
        samples[start + len.saturating_sub(1).min(samples.len() - start - 1)].upstream,
    );
}

#[test]
fn the_junction_bunch_grows_tile_by_tile_from_the_head_end() {
    // THE ASSERTION THAT CARRIES THE CLAIM. "Bunching" means the occupied run measured
    // FROM THE HEAD grows; a belt that is merely carrying items has occupancy scattered
    // along its length and a head-anchored prefix of zero or one. This reads
    // `head_prefix`, never a scalar count of occupied slots - the two numbers differ on
    // exactly the boards this test exists to tell apart. Index 0 is the HEAD, the deliver
    // end (see `slot_occupancy`); an inverted reading would make this pass on a belt
    // filling from the wrong end, which is why
    // `slot_occupancy_reads_index_zero_as_the_deliver_end` runs above it.
    let samples = drive_meet(MEET_FAST_TICKS_PER_SLOT, MEET_SLOW_TICKS_PER_SLOT);
    let (start, len) = longest_retention(&samples);
    assert!(
        len >= 2,
        "there is no retention window to measure growth across; see the sibling case"
    );
    let window = &samples[start..start + len];

    // Non-decreasing on EVERY tick of the window, checked against a running low-water mark
    // rather than by comparing the two endpoints: a prefix that collapsed and rebuilt in
    // between reads identical at both ends.
    let mut low_water = window[0].prefix;
    for (i, s) in window.iter().enumerate() {
        assert!(
            s.prefix >= low_water,
            "the head-anchored bunch must never shrink while the head is held, but the \
             prefix fell from {low_water} to {} on tick {i} of the retention window \
             (absolute tick {}). Upstream occupancy: {:?}",
            s.prefix,
            start + i,
            s.upstream,
        );
        low_water = s.prefix;
    }
    assert!(
        window[len - 1].prefix > window[0].prefix,
        "the bunch must GROW across the window - items behind the blocked head close up \
         against it tile by tile - but the prefix was {} at the start of the retention \
         window (tick {start}) and {} at its end. Upstream occupancy at the end: {:?}",
        window[0].prefix,
        window[len - 1].prefix,
        window[len - 1].upstream,
    );

    // And by the end of the window the bunch is GAP-FREE from the head: every occupied
    // slot is inside the prefix, nothing is stranded behind a gap. That is what
    // `tick.rs:844-848`'s "bunch tile-by-tile from the head end" means, and it is a
    // stronger statement than the prefix merely being large.
    let last = &window[len - 1];
    assert_eq!(
        last.prefix,
        filled(&last.upstream),
        "at the end of the retention window every occupied slot must lie inside the \
         head-anchored prefix (the bunch closed up), but the prefix is {} and {} slots are \
         occupied. Upstream occupancy: {:?}",
        last.prefix,
        filled(&last.upstream),
        last.upstream,
    );
}

#[test]
fn no_item_is_dropped_across_the_junction_on_any_tick() {
    // BELT-08's never-drop guarantee, kept as a SEPARATE case rather than folded into the
    // bunching assertions. A backlog test that does not count items cannot see this
    // however green it is: an engine that dropped the head instead of retaining it would
    // satisfy "the downstream is carrying items" on every tick of the window.
    let samples = drive_meet(MEET_FAST_TICKS_PER_SLOT, MEET_SLOW_TICKS_PER_SLOT);
    let mut low_water = 0usize;
    for (t, s) in samples.iter().enumerate() {
        let accounted = s.resident + s.dispatched;
        assert!(
            accounted >= low_water,
            "the item total across BOTH runs plus everything delivered must never fall, \
             but it went from {low_water} to {accounted} on tick {t}"
        );
        assert_eq!(
            accounted, s.injected,
            "every injected item must be accounted for on EVERY tick: {} injected by tick \
             {t}, but {} are resident on the two runs and {} have been dispatched. A \
             surplus means items were created; a shortfall means the junction dropped one",
            s.injected, s.resident, s.dispatched,
        );
        low_water = accounted;
    }
    let last = samples.last().expect("the window has samples");
    assert_eq!(
        last.injected, MEET_ITEMS,
        "all {MEET_ITEMS} items were injected inside the window, or the conservation \
         claim is about a board that was still filling"
    );
}

#[test]
fn the_two_runs_hold_different_paces_read_back_off_the_core() {
    // A test that trusts the commands it sent is satisfied by an engine that ignored them,
    // so both intervals are read back off FOLDED CORE STATE. `drive_meet` asserts the two
    // read-backs at the end of every window it drives, which is the moment the measurement
    // was taken; this case pins the values themselves and, separately, that they DIFFER -
    // without which every meet assertion above would be a claim about one pace.
    let mut b = Board::new();
    b.apply(
        GridCommand::DrawBelt {
            cells: vec![(1, 0), (2, 0)],
        },
        "draw a belt",
    );
    b.apply(
        GridCommand::DrawBelt {
            cells: vec![(1, 2), (2, 2)],
        },
        "draw another belt",
    );
    b.apply(
        GridCommand::Configure {
            node: 0,
            config: MachineConfig::Belt {
                ticks_per_slot: MEET_FAST_TICKS_PER_SLOT,
            },
        },
        "configure fast",
    );
    b.apply(
        GridCommand::Configure {
            node: 1,
            config: MachineConfig::Belt {
                ticks_per_slot: MEET_SLOW_TICKS_PER_SLOT,
            },
        },
        "configure slow",
    );
    assert_ne!(
        MEET_FAST_TICKS_PER_SLOT, MEET_SLOW_TICKS_PER_SLOT,
        "the two paces must differ, or SC3's 'two runs at two speeds' is one speed",
    );
    assert_eq!(b.pace_of(b.handle(0)), MEET_FAST_TICKS_PER_SLOT);
    assert_eq!(b.pace_of(b.handle(1)), MEET_SLOW_TICKS_PER_SLOT);
    assert_ne!(
        b.pace_of(b.handle(0)),
        b.pace_of(b.handle(1)),
        "two belt runs hold DIFFERENT ticks_per_slot on one board (BELT-03), read off the \
         core rather than assumed from the commands that were sent",
    );
    // Both inside the range plan 68-04 makes a write-side bound one wave later.
    for pace in [MEET_FAST_TICKS_PER_SLOT, MEET_SLOW_TICKS_PER_SLOT] {
        assert!(
            (2..=20).contains(&pace),
            "pace {pace} is outside D-68-01's 2..=20, so this file reddens the moment plan \
             68-04's write-side bound lands and the failure gets blamed on the bound",
        );
    }
}

#[test]
fn two_runs_at_the_same_pace_never_sustain_a_retained_head() {
    // THE NEGATIVE CONTROL, kept as a live test rather than spent as a one-off mutation
    // proof. `68-RESEARCH.md` names the failure it guards: an assertion that reads only
    // "upstream has items and downstream has items" is satisfied by any board where
    // transport is happening at all, INCLUDING one where both runs run at the same pace.
    // So the same board, the same window and the same instrument are driven with the two
    // paces made EQUAL, and the sustained retention must not appear.
    //
    // BOTH ends of the range are controlled, because "the downstream is slow" is a second
    // candidate explanation for the backlog and it has to be ruled out by measurement
    // rather than by argument. At 20-and-20 the downstream is exactly as slow as it is in
    // the positive case and the head is still not retained; the cause is the RATIO.
    let floor = (MEET_SLOW_TICKS_PER_SLOT - 1) as usize;
    for pace in [MEET_FAST_TICKS_PER_SLOT, MEET_SLOW_TICKS_PER_SLOT] {
        let samples = drive_meet(pace, pace);
        let (start, len) = longest_retention(&samples);
        assert!(
            len < floor,
            "with BOTH runs at {pace} ticks per slot there must be no sustained retained \
             head, but one lasted {len} ticks from tick {start} - which is at least the \
             {floor} the positive case requires, so that case is passing on something \
             other than the pace difference",
        );
        assert!(
            len <= 1,
            "measured: with both runs at {pace} the longest retention is 0 or 1 tick \
             (the upstream head is delivered on the tick it arrives). It was {len} ticks \
             from tick {start}",
        );
    }
}

// =================================================================================
// What a user can actually build today: the finding, kept as a running check
// =================================================================================

/// THE PHASE 74 TRACER (LINK-01 / LINK-08 / LINK-11 / LINK-14): ONE belt-to-belt join,
/// wired end to end from the serialized core, through the certified command path, to the
/// host render packet.
///
/// It is a TRACER rather than a unit test because of its last assertion. Steps 1 to 3 all
/// live inside `fabrico-core`/`fabrico-command`; step 4 lands on the RENDER PACKET, which
/// is the surface the frontend actually consumes, so a green run here means the whole
/// vertical slice holds and not just the model layer.
///
/// # What each step would catch on its own
/// 1. `ports_of` is `Some` on BOTH belts with the two records in `In`-first order. This is
///    the change everything else in the phase hangs off; without it step 2 dies inside the
///    Dock arm's port resolve, which is exactly where a belt-to-belt dock died before.
/// 2. The `Dock` returns `Ok` THROUGH THE CERTIFIED PATH. Never a write at the core seam:
///    `drive_meet` above builds its junction with `Host::core_mut().state.link(..)`
///    precisely because no `GridCommand` could produce one, and the whole point of this
///    case is that one now can.
/// 3. The link the fold wrote is the one the dock named, keyed `(A,0) -> (B,0)`. Both a
///    belt's `In` (catalog 0) and its `Out` (catalog 1, with zero preceding `Out`s) map to
///    link key 0, which is what `fold_dock` already writes on both ends, so the join needs
///    no new keyspace.
/// 4. The packet projects the SAME join from BOTH sides: A carries a Head dock naming B
///    and B carries a Tail dock naming A. This is the half a model-only assertion cannot
///    see, and `belt_docks` reaching it needs no node-kind filter removed - it never had
///    one, it had simply never been given a belt-to-belt dock to project.
#[test]
fn a_user_joins_two_belt_runs_into_one() {
    let mut b = Board::new();
    // Two abutting runs on one row: A ends at (2,0), B begins at (3,0). A's HEAD outward
    // side is E and B's TAIL outward side is W, so each end's outward step lands exactly
    // on the other's end tile - the same facing-adjacency rule a belt-to-machine dock
    // passes, applied to a belt target.
    b.apply(
        GridCommand::DrawBelt { cells: vec![(1, 0), (2, 0)] },
        "draw belt A, the upstream run",
    );
    b.apply(
        GridCommand::DrawBelt { cells: vec![(3, 0), (4, 0)] },
        "draw belt B, the downstream run",
    );
    let belt_a = b.handle(0);
    let belt_b = b.handle(1);

    // 1. BOTH belts are ported nodes, and both declare the same two records In-first.
    for (id, name) in [(belt_a, "A"), (belt_b, "B")] {
        let ports = b
            .host
            .core()
            .state
            .ports_of(id)
            .unwrap_or_else(|| panic!("belt {name} is a ported node"));
        assert_eq!(ports.len(), 2, "belt {name} declares exactly two ports");
        assert_eq!(
            ports[0].role,
            fabrico_core::state::Role::In,
            "belt {name}'s index 0 is the Tail, Role::In - In FIRST is a contract",
        );
        assert_eq!(
            ports[1].role,
            fabrico_core::state::Role::Out,
            "belt {name}'s index 1 is the Head, Role::Out",
        );
    }

    // 2. The join itself, through the certified path. Belt A's HEAD docks onto belt B's
    //    TAIL, which is B's catalog index 0 (its Role::In record).
    b.apply(
        GridCommand::Dock {
            belt: 0,
            endpoint: BeltEnd::Head,
            node: 1,
            port: 0,
        },
        "join belt A's head to belt B's tail",
    );

    // 3. The fold wrote the link the dock named.
    assert_eq!(
        b.host.core().state.link_target((belt_a, 0)),
        Some((belt_b, 0)),
        "the accepted belt-to-belt Dock links (A,0) -> (B,0)",
    );

    // 4. The render packet projects the join from BOTH sides. A fresh builder mints its
    //    own handle table, so both handles are read back off the builder that produced
    //    the packet rather than assumed equal to the board's own.
    let mut builder = RenderPacketBuilder::new();
    let pkt = builder.build_keyframe(&b.host);
    let ha = builder.handle_for_node(belt_a).expect("belt A is in the keyframe");
    let hb = builder.handle_for_node(belt_b).expect("belt B is in the keyframe");
    let view = |h: u64| {
        pkt.belts
            .iter()
            .find(|v| v.id == h)
            .unwrap_or_else(|| panic!("the keyframe carries the belt at handle {h}"))
    };
    let a_docks = &view(ha).docks;
    assert!(
        a_docks
            .iter()
            .any(|d| d.end == BeltEnd::Head && d.node == hb && d.port == 0),
        "belt A's packet carries a HEAD dock naming belt B: got {a_docks:?}",
    );
    let b_docks = &view(hb).docks;
    assert!(
        b_docks
            .iter()
            .any(|d| d.end == BeltEnd::Tail && d.node == ha && d.port == 0),
        "belt B's packet carries a TAIL dock naming belt A: got {b_docks:?}",
    );
}


#[test]
fn a_user_can_now_build_the_belt_to_belt_junction_and_the_machine_one_still_bunches() {
    // THE MEASURED DEVIATION, INVERTED IN PLACE RATHER THAN DELETED, so the assertion that
    // recorded the old truth is the assertion that records the new one. Through v8.0 this
    // case asserted that the certified path REFUSED a belt-to-belt dock, and it was right:
    // a belt declared no ports, so the Dock arm's port resolve returned None and the only
    // junction a user could build was a machine. Phase 74 (LINK-08, D-04) makes a belt a
    // ported node and the refusal is gone. The case is kept, and flipped, because it is
    // this file's running record of what a user can actually build - and a deleted case
    // would have left the header's claim standing with nothing measuring it.
    //
    // HALF ONE: the certified path now ACCEPTS a belt-to-belt dock, on the same board and
    // the same command that earned `Err(InvalidDock)` one commit ago. That prior red is
    // the mutation proof for the accept: this exact call is what a tree without the belt
    // Port write returns a refusal for.
    let mut b = Board::new();
    b.apply(
        GridCommand::DrawBelt {
            cells: vec![(1, 0), (2, 0)],
        },
        "draw belt A",
    );
    b.apply(
        GridCommand::DrawBelt {
            cells: vec![(3, 0), (4, 0)],
        },
        "draw belt B",
    );
    assert_eq!(
        b.try_apply(GridCommand::Dock {
            belt: 0,
            endpoint: BeltEnd::Head,
            node: 1,
            port: 0,
        }),
        Ok(()),
        "a belt is a ported node, so two belt runs join through the certified path - which \
         is why the junction in the SC3 cases above no longer has to be written at the \
         core seam",
    );

    // HALF TWO: the junction a user CAN build is a machine, and the upstream belt DOES
    // bunch against it. This is the `08-belt-speed-meet` topology - SOURCE -> fast belt ->
    // MERGE -> slow belt - driven on a live Host. The slow run saturates against its
    // undocked head, the MERGE is gated because its output cannot accept, and the fast run
    // packs FULL with the tile touching the junction occupied.
    //
    // THIS BLOCK IS THE RUNNING RECORD OF A REVERSAL, and it reddened exactly when it said
    // it would. Through v8.0 it asserted that the fast run drained to EMPTY and that the
    // surplus sat in an unbounded inbox where nothing drew it, citing the core's own
    // doctrine paragraph - the one that declared a machine inbox unbounded by design and
    // belt-to-machine bunching therefore impossible, and that plan 71-01 DELETED rather
    // than merely contradicted. D-68-10 routed the fix to v9.0's first
    // core-touching phase; `admit::MECHANICAL_INBOX_CAP` closed half of it (PILE-01) and
    // the fold's `outputs_blocked` gate closed the other half (PILE-02). The citation is
    // by NAME now rather than by line number, because a line number is what rotted.
    let mut m = Board::new();
    m.apply(
        GridCommand::Place {
            kind: machine_kind::SOURCE,
            cell_x: 0,
            cell_y: 0,
        },
        "place SOURCE",
    );
    // The 2x2 MERGE @ (5,0): In ports at world (5,0) and (5,1) facing W, its one Out at
    // world (6,0) facing E. The smallest junction node that passes items straight through.
    m.apply(
        GridCommand::Place {
            kind: machine_kind::MERGE,
            cell_x: 5,
            cell_y: 0,
        },
        "place the MERGE junction",
    );
    m.apply(
        GridCommand::DrawBelt {
            cells: vec![(1, 0), (2, 0), (3, 0), (4, 0)],
        },
        "draw the FAST run",
    );
    m.apply(
        GridCommand::Dock {
            belt: 2,
            endpoint: BeltEnd::Tail,
            node: 0,
            port: 0,
        },
        "dock the fast TAIL to the SOURCE Out",
    );
    m.apply(
        GridCommand::Dock {
            belt: 2,
            endpoint: BeltEnd::Head,
            node: 1,
            port: 0,
        },
        "dock the fast HEAD to the MERGE In",
    );
    m.apply(
        GridCommand::DrawBelt {
            cells: vec![(7, 0), (8, 0), (9, 0), (10, 0)],
        },
        "draw the SLOW run",
    );
    m.apply(
        GridCommand::Dock {
            belt: 3,
            endpoint: BeltEnd::Tail,
            node: 1,
            port: 2,
        },
        "dock the slow TAIL to the MERGE Out",
    );
    m.apply(
        GridCommand::Configure {
            node: 2,
            config: MachineConfig::Belt {
                ticks_per_slot: MEET_FAST_TICKS_PER_SLOT,
            },
        },
        "configure the fast run",
    );
    m.apply(
        GridCommand::Configure {
            node: 3,
            config: MachineConfig::Belt {
                ticks_per_slot: MEET_SLOW_TICKS_PER_SLOT,
            },
        },
        "configure the slow run",
    );
    let source = m.handle(0);
    let fast = m.handle(2);
    let slow = m.handle(3);
    let merge = m.handle(1);
    let slow_slots = slot_occupancy(&m.host, slow).len();

    // FED ONE ITEM PER TICK, not as a single burst, and that changed in 71-03. Since
    // `SOURCE_PENDING_CAP` bounds the source's own deque, a burst larger than the bound
    // is refused at the top of the chain and never enters the board at all - so a burst
    // can no longer load a chain whose total capacity is six queues deep. A per-tick
    // feed keeps offering while the source drains, which is what the shipped board's
    // timer does anyway.
    //
    // BUDGET, derived from the slow side: the slow belt needs `slow_slots` advances at
    // `MEET_SLOW_TICKS_PER_SLOT` ticks each just to pack its own slots, and only after
    // that do the queues behind it stop draining and start resting at their bounds. The
    // multiplier is headroom for the five queues upstream of it.
    let budget = 4 * slow_slots * MEET_SLOW_TICKS_PER_SLOT as usize;
    let mut admitted = 0usize;
    for i in 0..budget {
        let before = source_pending(&m.host, source);
        m.inject(source, &[(i & 0xFF) as u8]);
        m.tick();
        // MEASURED, not derived from the bound's own predicate: an offer that was
        // accepted either grew the deque or was fired out of it the same tick, so the
        // acceptance is read as "the source is not sitting at its bound". A test that
        // recomputed `SOURCE_PENDING_CAP`'s predicate would agree with a broken bound
        // as readily as with a correct one.
        if before < MECHANICAL_INBOX_CAP {
            admitted += 1;
        }
    }

    let fast_occ = slot_occupancy(&m.host, fast);
    let slow_occ = slot_occupancy(&m.host, slow);
    assert!(
        slow_occ.iter().all(|o| *o),
        "the SLOW run saturates against its own undocked head - that much was always \
         visible. Occupancy: {slow_occ:?}"
    );
    // THE INVERSION. D-68-10 IS NOW CLOSED ON BOTH SIDES.
    //
    // This assertion used to read `fast_occ.iter().all(|o| !*o)` - "and THE FAST RUN
    // STILL DRAINS TO EMPTY" - and it was the running record of the half of D-68-10 that
    // 71-01 could not close. The reason it drained was never that the junction's inbox
    // was unbounded (71-01 bounded it); it was that the junction machine kept CONSUMING
    // its inbox every tick even while its own output was being refused. Plan 71-03's
    // PILE-02 gate stops it: a machine whose linked output cannot accept is not stepped
    // at all, so it stops taking items off the belt in front of it and the backlog forms
    // WHERE A USER CAN SEE IT.
    assert!(
        fast_occ.iter().all(|o| *o),
        "and THE FAST RUN NOW BUNCHES INSTEAD OF DRAINING (PILE-02). The junction machine \
         is gated by `outputs_blocked` while the slow run refuses, so it stops consuming \
         and the backlog piles onto the fast belt where it is drawn. Occupancy: \
         {fast_occ:?}"
    );
    assert!(
        fast_occ[0],
        "and specifically the tile TOUCHING the junction stays occupied - the one bit \
         that separates a packed belt from one whose head is taken every tick"
    );
    // WHERE the surplus actually is, counted rather than asserted in prose. PHASE 71
    // CHANGED THIS ANSWER TWICE, and this block is the running record of both changes.
    //
    // It used to be "in an unbounded inbox where a user cannot see it": the merge drained
    // its inbox every tick and pushed straight into the downstream belt's inbox, and both
    // queues grew without limit. 71-01 bounded every mechanical inbox at
    // MECHANICAL_INBOX_CAP so neither queue could hide a backlog. 71-03 went further: the
    // machines now STOP, so the surplus rests on the BELTS and in the source's own
    // deque, all of it bounded and all of it either drawn or refused at the top.
    let merge_queue = inbox_count(&m.host, merge);
    let slow_queue = inbox_count(&m.host, slow);
    let fast_queue = inbox_count(&m.host, fast);
    assert!(
        merge_queue <= MECHANICAL_INBOX_CAP
            && slow_queue <= MECHANICAL_INBOX_CAP
            && fast_queue <= MECHANICAL_INBOX_CAP,
        "NO queue can hide a backlog: all three are bounded at {MECHANICAL_INBOX_CAP}. \
         MERGE inbox {merge_queue}, slow-belt inbox {slow_queue}, fast-belt inbox \
         {fast_queue}",
    );
    // AND NOTHING IS REFUSED AT AN OUTBOX DRAIN ANY MORE. This assertion used to read
    // `refused > 0` and it was correct: with the machines still consuming, everything
    // past a bound had already left its outbox and could only ride as an
    // `OutputRefused` fault payload. Under the gate the machine never emits it in the
    // first place, so the fault path is unreachable on this board. That is the whole
    // difference between a bound that faults and a machine that waits, and it is the
    // gate's own non-vacuity instrument: a non-zero here means a machine emitted more
    // than the gate had cleared.
    let refused = refused_on_fault_port(&m.host, source) + refused_on_fault_port(&m.host, merge);
    assert_eq!(
        refused, 0,
        "nothing was refused at an outbox drain: the gate stops each machine BEFORE it \
         emits, so no item ever has to ride as a dead letter"
    );
    // CONSERVATION over what the board ACCEPTED, across every place an item can be.
    let resident = source_pending(&m.host, source)
        + filled(&fast_occ)
        + filled(&slow_occ)
        + fast_queue
        + merge_queue
        + slow_queue;
    assert_eq!(
        resident, admitted,
        "every accepted item is in exactly one place: source pending {}, fast slots {}, \
         slow slots {}, fast inbox {fast_queue}, MERGE inbox {merge_queue}, slow-belt \
         inbox {slow_queue} - against {admitted} accepted",
        source_pending(&m.host, source),
        filled(&fast_occ),
        filled(&slow_occ),
    );
    // Non-vacuity: the board is genuinely SATURATED, not merely consistent. At least one
    // queue is AT its bound and the source is holding at its own.
    assert_eq!(
        source_pending(&m.host, source),
        SOURCE_PENDING_CAP,
        "and the SOURCE is holding at its own bound, so the whole chain is bounded rather \
         than the middle of it (PILE-04)"
    );
}

// =================================================================================
// LINK-01's NEGATIVES: what the widened accept arm still refuses, and WHY it refuses
// =================================================================================
//
// Phase 74 widened the `Dock` arm to admit a BELT target. A widening with nothing
// watching its refusals is how an accept envelope grows past what anyone meant, so these
// three cases watch it.
//
// EVERY ONE OF THEM FIRST ASSERTS `ports_of(target)` IS `Some`, and that clause is the
// whole point rather than a courtesy. Before 74-02 a belt declared no ports at all, so
// EVERY belt-to-belt dock was refused `InvalidDock` inside the port resolve. Without the
// port assertion these three cases would pass IDENTICALLY on a tree where belts had lost
// their ports again, certifying "the rule refused it" while the truth was "there was
// nothing to apply the rule to". With it, each case says: the ports are there, the rule
// ran, and the rule is what said no.
//
// The named rules live at `crates/fabrico-command/src/command.rs`: the role rule in the
// Dock arm's `role_ok` match, and the adjacency and facing-opposite checks immediately
// after the target resolution.

/// The board every negative below is measured on: belt A `[(1,0),(2,0)]` and belt B
/// `[(3,0),(4,0)]`, abutting, drawn through the certified path. Handles 0 and 1.
///
/// It is the TRACER's own board on purpose. The positive
/// [`a_user_joins_two_belt_runs_into_one`] accepts a Head dock of A onto B here, so every
/// refusal below is a refusal on a board where the very next accept is known to work -
/// which is what stops a negative passing because the board itself was broken.
fn abutting_pair() -> Board {
    let mut b = Board::new();
    b.apply(
        GridCommand::DrawBelt { cells: vec![(1, 0), (2, 0)] },
        "draw belt A, the upstream run",
    );
    b.apply(
        GridCommand::DrawBelt { cells: vec![(3, 0), (4, 0)] },
        "draw belt B, the downstream run",
    );
    b
}

/// Assert the node at `handle` declares the two belt ports, In first, and hand back the
/// count. This is the clause that makes a refusal below attributable to the RULE.
fn assert_target_is_ported(b: &Board, handle: usize, name: &str) {
    let ports = b
        .host
        .core()
        .state
        .ports_of(b.handle(handle))
        .unwrap_or_else(|| panic!("belt {name} is a ported node, so the rule has ports to judge"));
    assert_eq!(ports.len(), 2, "belt {name} declares exactly two ports");
    assert_eq!(
        ports[0].role,
        fabrico_core::state::Role::In,
        "belt {name}'s index 0 is the Tail, Role::In",
    );
    assert_eq!(
        ports[1].role,
        fabrico_core::state::Role::Out,
        "belt {name}'s index 1 is the Head, Role::Out",
    );
}

/// NEGATIVE 1: a belt that does not REACH is refused on adjacency and facing, not on
/// anything about belts.
///
/// Belt C at `[(7,0),(8,0)]` is a perfectly good dock target in every respect except
/// where it is: its Tail sits at `(7,0)` with outward W, so its outward step lands on
/// `(6,0)` while belt A's Head is at `(2,0)`. Four cells apart on the same row.
///
/// This is the SAME rule a belt-to-machine dock is judged by, which is LINK-01's whole
/// claim: the arm resolves a belt target through `belt_end_world` instead of `port_world`
/// and then runs the Phase-10 dock geometry unchanged.
///
/// NAMED CHANGES: plan 74.1-18 (gap N4c) moved the refusal from `InvalidDock` to
/// `InvalidBeltJoin`, the belt rule's own tag; plan 74.1-24 (gap J11) moved it to
/// `BeltEndsApart` ("These ends do not touch."), because the clause this board breaks is
/// the one-step distance. The same command is refused; only the tag moved.
#[test]
fn a_belt_that_does_not_reach_is_refused_on_the_adjacency_and_facing_rule() {
    let mut b = abutting_pair();
    b.apply(
        GridCommand::DrawBelt { cells: vec![(7, 0), (8, 0)] },
        "draw belt C, four cells away from A's head",
    );
    // THE CLAUSE. C is ported, so the refusal below cannot be port-absence.
    assert_target_is_ported(&b, 2, "C");

    assert_eq!(
        b.try_apply(GridCommand::Dock { belt: 0, endpoint: BeltEnd::Head, node: 2, port: 0 }),
        Err(CommandError::BeltEndsApart),
        "A's head does not reach C's tail, so the belt join's step rule refuses it",
    );
    // And the refusal wrote nothing.
    assert_eq!(
        b.host.core().state.link_target((b.handle(0), 0)),
        None,
        "the refused dock left A's head unlinked",
    );

    // THE CONTROL, on the same board and in the same run: the ONLY thing wrong with the
    // command above is where C is. Docking A onto B - which DOES reach - is accepted.
    // Without this line the case would still pass on a build that refused every
    // belt-to-belt dock outright, which is precisely the build this phase replaced.
    assert_eq!(
        b.try_apply(GridCommand::Dock { belt: 0, endpoint: BeltEnd::Head, node: 1, port: 0 }),
        Ok(()),
        "the same command onto the belt that DOES reach is accepted",
    );
}

/// NEGATIVE 2: naming the WRONG END of a REACHABLE target is refused on the role rule,
/// and the role rule is provably the only thing that could have refused it.
///
/// A Head dock is a LOAD: it delivers into the partner's admit end, `Role::In`, catalog
/// index 0. Naming the partner's index 1 names its HEAD, a `Role::Out` end, so two
/// deliver ends would meet and nothing would admit.
///
/// # The two boards, and why the case needs both
/// The obvious version of this case - name index 1 on the abutting `B` above - PASSES ON
/// A BUILD WITH THE ROLE RULE DELETED, measured: with `role_ok` disabled the arm resolves
/// B's Head at `(4,0)`, finds it does not reach `A`'s head at `(2,0)`, and returns the
/// SAME `InvalidDock` from the adjacency rule instead. The case would have been green
/// for a cause it does not name, which is the defect class this repository keeps finding.
///
/// So the refusal is measured on a board where the geometry PASSES. `D` occupies exactly
/// the cells `B` does and is drawn in the OPPOSITE direction, `[(4,0),(3,0)]`, so the end
/// meeting `A`'s head is `D`'s HEAD at `(3,0)` with outward W: it reaches, it faces
/// opposite, and the ONLY thing wrong with the dock is the role of the end it names. With
/// `role_ok` disabled this command returns `Ok`.
///
/// The accept CONTROL stays on the abutting board, where the same four fields with the
/// same geometry and the RIGHT role are accepted. Two boards differing only in the
/// direction one belt was drawn, and the difference in verdict is the role rule itself.
///
/// The role rule is also what makes the refusal readable. NAMED CHANGE (plan 74.1-18, gap
/// N4c): this refusal was `InvalidDock`, read as `A belt runs from an output to an input,
/// right next to it.`, which names ports a belt end does not have. It is now
/// `InvalidBeltJoin`, read since plan 74.1-24 as `A belt's end joins only a belt starting
/// right next to it, never turning back.`, and its "joins only a belt starting" is exactly
/// the rule this refusal broke: A's last tile was dropped on D's LAST tile, not its first.
/// Plan 74.1-24 left this pin on `InvalidBeltJoin`: the role rule has no tag of its own.
#[test]
fn a_head_dock_naming_the_targets_out_end_is_refused_on_the_role_rule() {
    // BOARD 1, the refusal. D is drawn tail-at-(4,0), head-at-(3,0), so its HEAD is the
    // end that meets A and the geometry is satisfied.
    let mut refusing = Board::new();
    refusing.apply(
        GridCommand::DrawBelt { cells: vec![(1, 0), (2, 0)] },
        "draw belt A, the upstream run",
    );
    refusing.apply(
        GridCommand::DrawBelt { cells: vec![(4, 0), (3, 0)] },
        "draw belt D on B's cells, drawn the other way so its HEAD meets A",
    );
    // THE CLAUSE. D is ported, so the refusal cannot be port-absence.
    assert_target_is_ported(&refusing, 1, "D");

    assert_eq!(
        refusing.try_apply(GridCommand::Dock {
            belt: 0,
            endpoint: BeltEnd::Head,
            node: 1,
            port: 1,
        }),
        Err(CommandError::InvalidBeltJoin),
        "a Head (load) dock naming D's Out end is refused on the role rule, on a board \
         where the adjacency and facing rules are both satisfied",
    );
    assert_eq!(
        refusing.host.core().state.link_target((refusing.handle(0), 0)),
        None,
        "the refused dock left A's head unlinked",
    );

    // BOARD 2, the accept control. The same cells, the same four command fields, and the
    // partner drawn the other way round so the end meeting A is its Role::In Tail.
    let mut accepting = abutting_pair();
    assert_target_is_ported(&accepting, 1, "B");
    assert_eq!(
        accepting.try_apply(GridCommand::Dock {
            belt: 0,
            endpoint: BeltEnd::Head,
            node: 1,
            port: 0,
        }),
        Ok(()),
        "the same dock naming an In end on the same cells is accepted",
    );
}

/// NEGATIVE 3, which is D-06's own argument closed: a GEOMETRY-EMPTY belt is refused on
/// the GEOMETRY check and provably not on port-absence.
///
/// D-06 rules that every belt gets both `Port` records, geometry-empty ones included,
/// deliberately breaking the neighbouring "absent means port-less" convention. That
/// ruling only pays for itself if the answer for such a belt is DEFINED rather than
/// accidental, and this is where it is defined: the ports are there, `ports_of` says so,
/// and the belt is still refused because it has no drawn end in world space to dock with.
///
/// The bare belt is minted at the CORE SEAM because no `GridCommand` produces one: a
/// `DrawBelt` always carries tiles. That is the same reason `drive_meet` above writes its
/// junction with `core_mut`.
#[test]
fn a_geometry_empty_belt_is_refused_on_geometry_and_not_on_port_absence() {
    let mut b = abutting_pair();
    // A belt with two slots and NO geometry, exactly the shape a `Wire`-minted belt has.
    let bare = b.host.core_mut().state.add_belt(2);
    // Give it the next dense handle, which is what `Board::apply` resolves against.
    b.nodes.push(bare);
    let bare_handle = b.nodes.len() - 1;

    // THE CLAUSE, and here it is the entire point of the case rather than a guard on it.
    assert_target_is_ported(&b, bare_handle, "the bare belt");
    assert!(
        match b.host.core().state.node(bare) {
            Some(Node::Belt(belt)) => belt.geometry.is_empty(),
            other => panic!("the minted node is a belt: {other:?}"),
        },
        "the bare belt has no geometry, which is the condition under test",
    );

    // AS A CARRIER: refused, because it has no drawn end to dock FROM.
    assert_eq!(
        b.try_apply(GridCommand::Dock {
            belt: bare_handle as u64,
            endpoint: BeltEnd::Head,
            node: 1,
            port: 0,
        }),
        Err(CommandError::InvalidDock),
        "a geometry-empty belt cannot be a dock carrier: no drawn end, not no ports",
    );
    // AS A TARGET: refused for the same reason from the other side.
    assert_eq!(
        b.try_apply(GridCommand::Dock {
            belt: 0,
            endpoint: BeltEnd::Head,
            node: bare_handle as u64,
            port: 0,
        }),
        Err(CommandError::InvalidDock),
        "a geometry-empty belt cannot be a dock target either",
    );
    assert_eq!(
        b.host.core().state.link_target((b.handle(0), 0)),
        None,
        "neither refused dock wrote a link",
    );
}

/// LINK-05 THROUGH THE HOST ADAPTER: a hand-drawn wire reconnects on the RUNNING app's
/// validation path, not only on the headless one.
///
/// # Why a wire case lives in a belt file, stated so it does not read as drift
/// `GridLookup` has TWO implementations and they are the host-side and headless halves of
/// ONE accept envelope: the headless `GridViewLookup` in `fabrico-command`, and the
/// adapter in `fabrico-host`'s `input_apply.rs`. 74-06's wire-carrier clause had to be
/// added to BOTH, or a gesture the command layer accepts would be refused by the app the
/// user runs. `crates/fabrico-command/tests/wire_unlink_redock.rs` covers the headless
/// half in full; this case is the host half, and it is here because `Board` above is the
/// host-side gesture harness already in reach. A mirror with a witness on only one side
/// is how the two halves start disagreeing.
///
/// The board is two 1x1 `ENDPOINT` machines, the repository's first electrical ports: In
/// at catalog 0 facing W, Out at catalog 1 facing E, both `Medium::Electrical`.
#[test]
fn a_drawn_wire_reconnects_through_the_host_adapters_dock_arm_too() {
    let mut b = Board::new();
    b.apply(
        GridCommand::Place { kind: machine_kind::ENDPOINT, cell_x: 0, cell_y: 5 },
        "place the source-side endpoint",
    );
    b.apply(
        GridCommand::Place { kind: machine_kind::ENDPOINT, cell_x: 6, cell_y: 5 },
        "place the target-side endpoint",
    );
    // Catalog index 1 is the Out, index 0 the In - In first, per the catalog invariant.
    b.apply(
        GridCommand::DrawWire { from_node: 0, from_port: 1, to_node: 1, to_port: 0 },
        "draw the wire between the two electrical ports",
    );
    let target = b.handle(1);
    let wire = *b
        .host
        .core()
        .last_tick
        .placed
        .last()
        .expect("the DrawWire minted the wire node");
    // The wire's own dense handle is the next slot in the board's table.
    let wire_handle = (b.nodes.len() - 1) as u64;
    assert_eq!(b.handle(b.nodes.len() - 1), wire, "the last minted node is the wire");
    assert_eq!(
        b.host.core().state.link_target((wire, 0)),
        Some((target, 0)),
        "the drawn wire delivers into the target endpoint's In port",
    );

    // DISCONNECT, then RECONNECT with the identical four fields, both through the host's
    // own gesture path. The reconnect is the half that returned Err(InvalidDock) on HEAD.
    b.apply(
        GridCommand::Unlink {
            belt: wire_handle,
            endpoint: BeltEnd::Head,
            node: 1,
            port: 0,
        },
        "disconnect the wire",
    );
    assert_eq!(
        b.host.core().state.link_target((wire, 0)),
        None,
        "the disconnect removed the wire's delivery link",
    );
    assert_eq!(
        b.try_apply(GridCommand::Dock {
            belt: wire_handle,
            endpoint: BeltEnd::Head,
            node: 1,
            port: 0,
        }),
        Ok(()),
        "the host adapter accepts the reconnect, exactly as the headless session does",
    );
}
