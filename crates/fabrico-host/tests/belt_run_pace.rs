//! Phase 68-02 (BELT-01/BELT-02): the belt-run pace frame, on the seam the shipped
//! app actually uses.
//!
//! # Why this file exists at all
//! `68-CONTEXT.md` D-68-07 and `68-UI-SPEC.md` FINDING 2 both prescribe
//! `Session::apply_under_action` for the N-belts-one-undo-step property. That is the
//! right mechanism for the HEADLESS crate and it is reachable from NO host code path:
//! `fabrico-scenario` and tests call it, the running app does not. The app goes
//! `input_apply::apply_gesture` -> `Host::enqueue_edit_with_new_action`, whose own
//! comment reads *"one undo step per normal gesture"*. So a fan-out proved only in
//! `fabrico-command` ships GREEN over an app that produces N undo steps - this
//! project's signature defect exactly, and the reason D-68-16 renamed the live seam
//! as `Host::enqueue_action_group`.
//!
//! # Every case drives the REAL decode
//! Each test goes through `decode_gesture` and then `apply_gesture_frame`, never
//! calling the fan-out directly. Route R1 rests on the `0xFE` sentinel peek, so a
//! test that skipped the decode would be proving the half of the route that was
//! never in doubt.
//!
//! NOT feature-gated in any way: `cargo test -p fabrico-host` runs every case here.

use fabrico_command::CommandError;
use fabrico_core::belt_slots::DEFAULT_TICKS_PER_SLOT;
use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::edit::{EditOp, EditRecord};
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::NodeId;
use fabrico_core::persist::RedbStore;
use fabrico_core::state::Node;
use fabrico_host::driver::Host;
use fabrico_host::input_apply::{apply_gesture, apply_gesture_frame};
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::sim_loop::{BELT_RUN_PACE_LEAD, BeltRunPace, GestureFrame, MAX_RUN_PACE_BELTS};
use fabrico_host::transport_ws::{decode_gesture, frame_gesture};
use fabrico_protocol::{GridCommand, MachineConfig, machine_kind};
use std::collections::BTreeSet;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// Frame a gesture BODY as the client does since phase 88 (a two-varint header, generation 0
/// and gesture 1, then the body) and read it back through the real `decode_gesture`, the one
/// decoder both transports call. Every decode in this file goes through here, so each case
/// still reads the body it was written for.
fn decode_body(body: &[u8]) -> Result<GestureFrame, CommandError> {
    decode_gesture(&frame_gesture(0, 1, body))
        .map(|d| d.frame)
        .map_err(|e| e.error)
}

// =================================================================================
// Rig
// =================================================================================

fn header() -> LogHeader {
    LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: 7,
    }
}

/// A real `Host` over tempfile redb stores: the `test_host()` shape from
/// `input_apply.rs`, which needs no scene timers and no sim loop.
fn test_host() -> (tempfile::TempDir, Host) {
    let dir = tempfile::tempdir().expect("tempdir");
    let core = Core::genesis(header());
    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    (dir, Host::new(core, store, ledger, None).expect("open host"))
}

/// The per-tick channels `tick_once` drains (gestures ride the EDIT log, not these).
#[allow(clippy::type_complexity)]
fn channels() -> (
    UnboundedReceiver<EventPayload>,
    UnboundedSender<Command>,
    UnboundedReceiver<ResultEvent>,
) {
    let (_ingress_tx, ingress_rx) = unbounded_channel::<EventPayload>();
    let (cmd_tx, _cmd_rx) = unbounded_channel::<Command>();
    let (_res_tx, results_rx) = unbounded_channel::<ResultEvent>();
    (ingress_rx, cmd_tx, results_rx)
}

/// A board plus the dense-handle table the gesture frames address it by. The handle
/// IS the index into `nodes`, which is the whole of the `resolve` closure's job.
struct Board {
    _dir: tempfile::TempDir,
    host: Host,
    ingress_rx: UnboundedReceiver<EventPayload>,
    cmd_tx: UnboundedSender<Command>,
    results_rx: UnboundedReceiver<ResultEvent>,
    nodes: Vec<NodeId>,
}

impl Board {
    fn new() -> Self {
        let (dir, host) = test_host();
        let (ingress_rx, cmd_tx, results_rx) = channels();
        Self {
            _dir: dir,
            host,
            ingress_rx,
            cmd_tx,
            results_rx,
            nodes: Vec::new(),
        }
    }

    fn tick(&mut self) {
        self.host
            .tick_once(&mut self.ingress_rx, &mut self.results_rx, &self.cmd_tx)
            .expect("tick folds the enqueued edits");
    }

    /// Draw a belt through the CERTIFIED command path and register its handle.
    fn draw_belt(&mut self, cells: &[(i32, i32)]) -> u64 {
        apply_gesture(
            &mut self.host,
            GridCommand::DrawBelt {
                cells: cells.to_vec(),
            },
            |_h| None,
        )
        .expect("a legal drawn path is accepted");
        self.tick();
        self.register_last_placed()
    }

    /// Place a machine through the certified path and register its handle.
    fn place(&mut self, kind: u8, cell_x: i32, cell_y: i32) -> u64 {
        apply_gesture(
            &mut self.host,
            GridCommand::Place {
                kind,
                cell_x,
                cell_y,
            },
            |_h| None,
        )
        .expect("place at a free cell");
        self.tick();
        self.register_last_placed()
    }

    fn register_last_placed(&mut self) -> u64 {
        let id = *self
            .host
            .core()
            .last_tick
            .placed
            .last()
            .expect("the fold minted an id");
        self.nodes.push(id);
        (self.nodes.len() - 1) as u64
    }

    /// Feed RAW FRAME BYTES through the real decoder and the real dispatcher: the
    /// exact two steps the sim-loop drain takes for every inbound gesture.
    fn feed(&mut self, bytes: &[u8]) -> Result<(), CommandError> {
        let frame = decode_body(bytes)?;
        let table = self.nodes.clone();
        apply_gesture_frame(&mut self.host, frame, move |h| {
            table.get(h as usize).copied()
        })
    }

    fn edit_log(&self) -> Vec<EditRecord> {
        self.host.logged_edits().expect("read the edit log")
    }

    /// The belt's LIVE advance interval, read off folded core state.
    fn pace_of(&self, handle: u64) -> u32 {
        let id = self.nodes[handle as usize];
        match self.host.core().state.node(id) {
            Some(Node::Belt(belt)) => belt.ticks_per_slot.get(),
            other => panic!("handle {handle} is not a live belt: {other:?}"),
        }
    }
}

/// Encode a run-pace frame EXACTLY as `frontend/src/protocol/decode.ts`'s
/// `encodeBeltRunPace` does: the sentinel as ONE RAW BYTE, then the postcard body.
///
/// Hand-assembled rather than `postcard::to_allocvec(&BeltRunPace)` prefixed with the
/// byte: the point of these cases is that the BROWSER's bytes decode, and building
/// them from the Rust struct would sample the decoder against its own serializer.
fn run_frame(belts: &[u64], ticks_per_slot: u32) -> Vec<u8> {
    let mut out = vec![BELT_RUN_PACE_LEAD];
    varint(&mut out, belts.len() as u64);
    for &b in belts {
        varint(&mut out, b);
    }
    varint(&mut out, u64::from(ticks_per_slot));
    out
}

/// LEB128, the grammar `PostcardWriter.varintU` writes.
fn varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8 & 0x7f) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

/// The DISTINCT `action` ids across the Configure records in the log.
fn configure_actions(log: &[EditRecord]) -> BTreeSet<u64> {
    log.iter()
        .filter(|r| matches!(r.op, EditOp::Configure { .. }))
        .map(|r| r.action)
        .collect()
}

/// A three-belt board: three separate drawn belts, all at the crate default pace.
fn three_belt_board() -> Board {
    let mut b = Board::new();
    b.draw_belt(&[(1, 1), (2, 1)]);
    b.draw_belt(&[(1, 3), (2, 3)]);
    b.draw_belt(&[(1, 5), (2, 5)]);
    b
}

/// A pace that is NOT the crate default, so every assertion below can fail.
const NEW_PACE: u32 = 10;

// =================================================================================
// Test 1: THE ONE THAT MATTERS
// =================================================================================

#[test]
fn a_three_belt_run_frame_lands_under_exactly_one_action_id() {
    // The BLOCKING FINDING's own check, and nothing else in the tree can see the
    // defect it guards. The assertion is the CARDINALITY of the distinct `action`
    // set, deliberately not "three records exist" and not "the three belts hold the
    // new pace", both of which stay fully GREEN under the very mutation that breaks
    // undo (three `enqueue_edit_with_new_action` calls). See the plan's
    // `## Mutation proof`.
    let mut b = three_belt_board();
    assert_ne!(
        DEFAULT_TICKS_PER_SLOT.get(),
        NEW_PACE,
        "the written pace must differ from the default, or this case cannot fail",
    );

    b.feed(&run_frame(&[0, 1, 2], NEW_PACE))
        .expect("a three-belt run frame naming three live belts is accepted");
    b.tick();

    let log = b.edit_log();
    let configures: Vec<&EditRecord> = log
        .iter()
        .filter(|r| matches!(r.op, EditOp::Configure { .. }))
        .collect();
    assert_eq!(
        configures.len(),
        3,
        "one Configure record per belt named in the frame",
    );
    assert_eq!(
        configure_actions(&log).len(),
        1,
        "THE WHOLE POINT: N belts, ONE action id, so ONE Ctrl+Z. Got actions {:?}",
        configure_actions(&log),
    );
    for handle in [0, 1, 2] {
        assert_eq!(
            b.pace_of(handle),
            NEW_PACE,
            "belt {handle} folded the new pace",
        );
    }
}

// =================================================================================
// Test 2: one Undo restores the whole run
// =================================================================================

#[test]
fn one_undo_restores_every_belt_in_the_run() {
    let mut b = three_belt_board();
    let before = DEFAULT_TICKS_PER_SLOT.get();

    b.feed(&run_frame(&[0, 1, 2], NEW_PACE))
        .expect("the run frame is accepted");
    b.tick();
    assert!(b.host.can_undo(), "an applied run is undoable");

    // ONE Undo, through the same decode-and-dispatch path.
    b.feed(&postcard::to_allocvec(&GridCommand::Undo).expect("encode Undo"))
        .expect("undo is accepted");
    b.tick();

    for handle in [0, 1, 2] {
        assert_eq!(
            b.pace_of(handle),
            before,
            "belt {handle} is back at its previous pace after ONE undo",
        );
    }
    assert!(
        b.host.can_redo(),
        "the undone run is redoable, so the cursor moved by exactly one step",
    );
}

// =================================================================================
// Test 3: validate ALL, then enqueue
// =================================================================================

#[test]
fn a_refusal_on_the_second_belt_leaves_the_edit_log_untouched() {
    // The OTHER case that can silently not fail. An assertion that only checks the
    // returned `Err` is satisfied by an implementation that enqueued the first record
    // and then failed on the second: the half-applied run, where the user is told the
    // pace was refused and is looking at a run running at two paces.
    let mut b = Board::new();
    b.draw_belt(&[(1, 1), (2, 1)]); // handle 0
    b.place(machine_kind::SINK, 6, 6); // handle 1: NOT a belt
    b.draw_belt(&[(1, 5), (2, 5)]); // handle 2

    let before_len = b.edit_log().len();
    let before_paces = [b.pace_of(0), b.pace_of(2)];

    let verdict = b.feed(&run_frame(&[0, 1, 2], NEW_PACE));
    assert_eq!(
        verdict,
        Err(CommandError::UnknownNode),
        "a handle that is not a belt refuses the WHOLE frame with a typed error",
    );
    b.tick();

    assert_eq!(
        b.edit_log().len(),
        before_len,
        "NOTHING was enqueued: the log length is unchanged, not merely an Err returned",
    );
    assert_eq!(
        [b.pace_of(0), b.pace_of(2)],
        before_paces,
        "and no belt moved: a refusal leaves the board byte-identical (SC#2)",
    );
}

#[test]
fn an_unresolvable_handle_refuses_the_whole_frame() {
    let mut b = three_belt_board();
    let before_len = b.edit_log().len();

    // Handle 9 is past the table: a stale or forged handle.
    assert_eq!(
        b.feed(&run_frame(&[0, 9, 2], NEW_PACE)),
        Err(CommandError::UnknownNode),
    );
    b.tick();
    assert_eq!(b.edit_log().len(), before_len, "nothing was enqueued");
    assert_eq!(
        b.pace_of(0),
        DEFAULT_TICKS_PER_SLOT.get(),
        "the belt named BEFORE the bad handle did not move",
    );
}

#[test]
fn a_zero_interval_is_refused_with_its_own_typed_error() {
    // `validate_normalize` owns this refusal (`ZeroBeltInterval`) and the run arm
    // propagates it rather than defaulting: `unwrap_or(DEFAULT_TICKS_PER_SLOT)` would
    // hand the user a working belt running at a speed they did not choose (T-63-24).
    let mut b = three_belt_board();
    let before_len = b.edit_log().len();
    assert_eq!(
        b.feed(&run_frame(&[0, 1, 2], 0)),
        Err(CommandError::ZeroBeltInterval),
    );
    assert_eq!(b.edit_log().len(), before_len, "nothing was enqueued");
}

// =================================================================================
// Test 4: the empty list never reaches the empty-group early return
// =================================================================================

#[test]
fn a_zero_belt_run_frame_is_refused_and_consumes_no_action_id() {
    // `Host::enqueue_action_group` returns early on an empty group WITHOUT minting an
    // action id, which would answer `Ok(())` to a gesture that did nothing. That early
    // return must never be what a user gesture gets, so the arm refuses first.
    let mut b = three_belt_board();
    let before_len = b.edit_log().len();

    assert_eq!(
        b.feed(&run_frame(&[], NEW_PACE)),
        Err(CommandError::Malformed),
        "an empty run is a typed refusal, never a silent Ok",
    );
    b.tick();
    assert_eq!(b.edit_log().len(), before_len, "nothing was enqueued");

    // The action id was NOT consumed: the next real edit takes the id the empty frame
    // would have burned. Asserted through behaviour rather than by reading
    // `next_action`, which is private: a run applied now is still ONE action.
    b.feed(&run_frame(&[0], NEW_PACE))
        .expect("a one-belt run after the refusal is accepted");
    b.tick();
    assert_eq!(
        configure_actions(&b.edit_log()).len(),
        1,
        "the refused empty frame left the action counter alone",
    );
}

// =================================================================================
// Test 5: the DoS rows (T-68-02-01)
// =================================================================================

#[test]
fn an_over_cap_belt_list_is_a_typed_error_not_an_allocation() {
    let mut b = three_belt_board();
    let before_len = b.edit_log().len();

    // Declared count one past the cap, with a body that honestly carries that many
    // handles. Refused on the DECODED length as well as on the pre-allocation peek.
    let belts: Vec<u64> = (0..=MAX_RUN_PACE_BELTS as u64).collect();
    assert_eq!(
        decode_body(&run_frame(&belts, NEW_PACE)),
        Err(CommandError::Malformed),
        "an over-cap list is refused before any per-belt work",
    );
    assert_eq!(
        b.feed(&run_frame(&belts, NEW_PACE)),
        Err(CommandError::Malformed),
    );
    assert_eq!(b.edit_log().len(), before_len, "nothing was enqueued");
}

#[test]
fn an_enormous_declared_count_with_a_short_body_returns_promptly() {
    // The forged-count row. A frame claiming u32::MAX handles and carrying three bytes
    // must be a typed error, NOT a multi-gigabyte allocation and NOT a hang. The
    // pre-allocation varint peek in `decode_gesture` is what makes this prompt:
    // postcard is never asked to build the sequence at all.
    let mut frame = vec![BELT_RUN_PACE_LEAD];
    varint(&mut frame, u64::from(u32::MAX));
    frame.extend_from_slice(&[1, 2, 3]);
    assert_eq!(decode_body(&frame), Err(CommandError::Malformed));

    // And the same for a count that would fit in memory but still exceeds the cap,
    // with no body at all behind it.
    let mut sparse = vec![BELT_RUN_PACE_LEAD];
    varint(&mut sparse, 5_000);
    assert_eq!(decode_body(&sparse), Err(CommandError::Malformed));
}

#[test]
fn a_run_frame_at_the_cap_is_accepted_by_the_decoder() {
    // The bound must be a BOUND, not an off-by-one that refuses the largest legal
    // frame. Decode only: resolving 256 live belts is not what this case is about.
    let belts: Vec<u64> = (0..MAX_RUN_PACE_BELTS as u64).collect();
    match decode_body(&run_frame(&belts, NEW_PACE)) {
        Ok(GestureFrame::RunPace(run)) => {
            assert_eq!(run.belts.len(), MAX_RUN_PACE_BELTS);
            assert_eq!(run.ticks_per_slot, NEW_PACE);
        }
        other => panic!("a frame exactly at the cap must decode: {other:?}"),
    }
}

// =================================================================================
// Test 6: the malformed-sentinel rows (T-68-02-02)
// =================================================================================

#[test]
fn an_empty_a_bare_sentinel_and_a_truncated_body_are_typed_errors_not_panics() {
    // An EMPTY slice would be an index panic on a `bytes[0]` peek, which is why the
    // length check runs first. `decode_gesture`'s never-panic contract is what keeps
    // the dev socket alive under a hostile local process.
    assert_eq!(decode_body(&[]), Err(CommandError::Malformed), "empty");
    assert_eq!(
        decode_body(&[BELT_RUN_PACE_LEAD]),
        Err(CommandError::Malformed),
        "a bare sentinel with no body",
    );
    assert_eq!(
        decode_body(&[BELT_RUN_PACE_LEAD, 2, 7]),
        Err(CommandError::Malformed),
        "a body declaring two handles and carrying one, with no interval",
    );
    assert_eq!(
        decode_body(&[BELT_RUN_PACE_LEAD, 1, 7]),
        Err(CommandError::Malformed),
        "a body with the handle but no ticks_per_slot",
    );
    // A continuation-bit run with no terminator: the varint peek is bounded at ten
    // bytes, so this returns rather than spinning.
    assert_eq!(
        decode_body(&[BELT_RUN_PACE_LEAD, 0x80, 0x80, 0x80, 0x80, 0x80]),
        Err(CommandError::Malformed),
        "an unterminated varint",
    );
}

// =================================================================================
// Test 8: 0xFF is STILL rejected, so the non-collision argument keeps a check
// =================================================================================

#[test]
fn ff_is_still_an_invalid_lead_byte_after_fe_became_a_sentinel() {
    // The sentinel's non-collision argument rests on `GridCommand` having no
    // discriminant anywhere near 254. That claim needs a LIVE check now that 0xFE is
    // spoken for; this is the host-side half (the app-side half is amended in place in
    // `crates/fabrico-app/src/lib.rs`).
    assert_eq!(
        decode_body(&[0xFF, 0xFF, 0xFF]),
        Err(CommandError::Malformed),
    );
    assert_eq!(decode_body(&[0xFD]), Err(CommandError::Malformed));
}

// =================================================================================
// Test 9: the regression floor for the widened decoder
// =================================================================================

#[test]
fn every_shipped_gridcommand_frame_decodes_exactly_as_it_did_at_head() {
    // LITERAL BYTE ARRAYS, not `postcard::to_allocvec` round-trips: the claim under
    // test is that bytes ALREADY IN THE WORLD still mean what they meant, and a
    // round-trip through the current serializer cannot see a renumber because both
    // halves would move together.
    let cases: [(&[u8], GridCommand); 4] = [
        (
            // disc 0, kind 2 (Factory), zigzag(4)=8, zigzag(5)=10
            &[0x00, 0x02, 0x08, 0x0A],
            GridCommand::Place {
                kind: 2,
                cell_x: 4,
                cell_y: 5,
            },
        ),
        // The SHORTEST frame in the set: a bare discriminant.
        (&[0x05], GridCommand::Undo),
        (&[0x06], GridCommand::Redo),
        (
            // disc 9 Configure, node 3, nested disc 3 Belt, ticks_per_slot 4
            &[0x09, 0x03, 0x03, 0x04],
            GridCommand::Configure {
                node: 3,
                config: MachineConfig::Belt { ticks_per_slot: 4 },
            },
        ),
    ];
    for (bytes, want) in cases {
        assert_eq!(
            decode_body(bytes),
            Ok(GestureFrame::Cmd(want.clone())),
            "the shipped frame {bytes:?} must still decode to {want:?}",
        );
    }
}

#[test]
fn a_run_frame_decodes_to_the_run_variant_with_its_contents_intact() {
    // The positive half of test 9: the sentinel routes, and the body survives.
    assert_eq!(
        decode_body(&run_frame(&[3, 9, 300], 20)),
        Ok(GestureFrame::RunPace(BeltRunPace {
            belts: vec![3, 9, 300],
            ticks_per_slot: 20,
        })),
    );
}

// =================================================================================
// Test 10 (68-04): the `2..=20` write bound, reached through the SHIPPED route
// =================================================================================

#[test]
fn a_run_frame_carrying_an_out_of_range_pace_is_refused_and_enqueues_nothing() {
    // BELT-04. The bound lives in `validate_normalize` and is asserted from the
    // headless side in `fabrico-command`; this is the LIVE half, driven through
    // `decode_gesture` + `apply_gesture_frame` so it exercises the route a user's
    // Apply actually takes.
    //
    // The EDIT-LOG LENGTH is asserted alongside the tag, and that is the load-bearing
    // half. A run refused on its Kth belt with K-1 records already enqueued is a
    // HALF-APPLIED run - the state 68-02's validate-all-then-enqueue ordering exists to
    // make unreachable - and the pace bound is a new way to reach it. The returned
    // error alone cannot see that; only the length can.
    for pace in [1u32, 21, u32::MAX] {
        let mut b = three_belt_board();
        let before_len = b.edit_log().len();
        let before_paces: Vec<u32> = (0..3).map(|h| b.pace_of(h)).collect();

        assert_eq!(
            b.feed(&run_frame(&[0, 1, 2], pace)),
            Err(CommandError::PaceOutOfRange),
            "a run frame carrying pace {pace} is refused with its own typed tag",
        );
        b.tick();

        assert_eq!(
            b.edit_log().len(),
            before_len,
            "pace {pace}: the refusal enqueued NOTHING - not even the first belt",
        );
        for handle in 0..3 {
            assert_eq!(
                b.pace_of(handle),
                before_paces[handle as usize],
                "pace {pace}: belt {handle} is untouched",
            );
        }
    }
}

#[test]
fn a_run_frame_carrying_a_zero_pace_still_lands_on_the_belt_interval_tag() {
    // The two refusals stay DISTINGUISHABLE on the live route as well as the headless
    // one, which is what keeps each shipped sentence true of its own cause.
    let mut b = three_belt_board();
    assert_eq!(
        b.feed(&run_frame(&[0, 1, 2], 0)),
        Err(CommandError::ZeroBeltInterval),
        "zero keeps its own tag; the range bound must not swallow it",
    );
}

#[test]
fn a_run_frame_at_each_end_of_the_offered_range_is_accepted() {
    // Anti-vacuity for the pair above: the bound is a BOUND, not a blanket refusal, and
    // neither end is an off-by-one. 2 is the fast end (exactly half the measured
    // aliasing wall) and 20 is the chosen slow floor.
    for pace in [2u32, 20] {
        let mut b = three_belt_board();
        b.feed(&run_frame(&[0, 1, 2], pace))
            .unwrap_or_else(|e| panic!("the offered end pace {pace} must be accepted, got {e:?}"));
        b.tick();
        for handle in 0..3 {
            assert_eq!(b.pace_of(handle), pace, "pace {pace}: belt {handle} folded it");
        }
    }
}
