//! The authoritative gesture-application service — validate a place/wire/delete
//! gesture host-side through the SAME `fabrico-command` validation the headless
//! harness uses, then enter it into the core ONLY as one logged, RESOLVED
//! [`EditRecord`](fabrico_core::edit::EditRecord) the fold applies (CMD-05). The
//! webview NEVER writes grid state.
//!
//! # One validation path, two producers (CMD-01)
//! A gesture — even from our own webview — is UNTRUSTED input (RESEARCH Security
//! V5). [`apply_gesture`] builds a host [`GridLookup`] adapter over the deterministic
//! [`Core`] (occupancy + cells + node kinds, the single SPAT-01 authority) + this
//! tick's enqueued-edit buffer (same-tick occupancy, WR-01) + the dense-handle
//! `resolve` closure, and runs the IDENTICAL
//! [`fabrico_command::validate_normalize`] the headless `fabrico-command` crate
//! runs ("one schema, two producers", CMD-01). On accept it enqueues the RESOLVED
//! [`EditRecord`] onto the host EDIT LOG via [`Host::enqueue_edit`] (08-05) — never
//! the runtime EVENT ingress; on reject it returns a typed
//! [`CommandError`](fabrico_command::CommandError) having mutated/enqueued nothing
//! (SC#2/SC5). No path here touches `core.state` directly — every mutation is a
//! pure projection of the edit-log, so replay reconstructs the topology
//! (T-8-GESTURE-OPTIMISTIC).
//!
//! # Dense render handles, not `NodeId`
//! [`GridCommand::Dock`]/[`GridCommand::Delete`] carry the dense `u64` render
//! handles the frontend sees in [`NodeView`](fabrico_protocol::NodeView)`.id` — NOT
//! the core's generational `NodeId`. The caller supplies a `resolve: u64 ->
//! Option<NodeId>` closure (the inverse of the render builder's dense-handle table,
//! [`RenderPacketBuilder::node_for_handle`](crate::render_packet::RenderPacketBuilder::node_for_handle));
//! an unknown handle is a [`CommandError::UnknownNode`](fabrico_command::CommandError::UnknownNode),
//! so a gesture against a stale or forged handle changes nothing (T-8-GESTURE-PANIC).
//!
//! # Same-tick occupancy (WR-01)
//! The host batches gestures into one tick; this tick's enqueued edits fold
//! EDITS-FIRST inside `tick_once`, AFTER the gesture-drain loop. So a `Place`'s cell
//! is not in core `GridState` yet when a LATER same-tick gesture validates. The
//! adapter therefore reads occupancy from `core.state` plus a replay, in enqueue order,
//! of every record in the host's enqueued-edit buffer ([`Host::pending_edits`]) that
//! moves cells: `Place`, `DrawBelt`, `Delete`, `Rotate`, `AddPort`, `RemovePort` and,
//! since phase 76 (plan 76-07, CR-02), `Configure{Label}`. That collapses the WR-01
//! TOCTOU without any parallel sidecar map. A `Wire` carries no cell (a belt drawn as
//! a wire has none, W1). Which site reads which record, and where the next cell-moving
//! record must go, is the `# Every pending-record replay in this file` section of
//! `HostGridLookup`'s docblock.
//!
//! The validation and the enqueue moved to `fabrico_engine::gesture`, so a board can take scripted
//! edits with no host. This file keeps the wrapper with the old signature, the frame entry point
//! and the belt-run fan-out.

use fabrico_command::{CommandError, GridLookup, validate_normalize};
use fabrico_core::edit::EditRecord;
use fabrico_core::ids::NodeId;
use fabrico_protocol::{GridCommand, machine_kind};

#[doc(hidden)]
pub use fabrico_engine::gesture::{HostGridLookup, kind_byte};

// The tests below reach these through `use super::*`.
#[cfg(test)]
use fabrico_core::state::{Footprint, Node, Port};
#[cfg(test)]
use slotmap::Key;

use crate::driver::Host;
use crate::sim_loop::{BeltRunPace, GestureFrame, MAX_RUN_PACE_BELTS};

/// Validate a [`GridCommand`] and, on accept, enqueue it onto the host's edit log. The body,
/// and the full contract, is [`fabrico_engine::gesture::apply_gesture`]; this keeps the old
/// signature so a caller holding a [`Host`] doesn't change.
///
/// # Errors
/// The typed [`CommandError`] that fired. A refused gesture changes nothing.
pub fn apply_gesture(
    host: &mut Host,
    cmd: GridCommand,
    resolve: impl Fn(u64) -> Option<NodeId>,
) -> Result<(), CommandError> {
    fabrico_engine::gesture::apply_gesture(host.engine_mut(), cmd, resolve)
}

/// Apply ONE decoded [`GestureFrame`]: the drain's entry point since Phase 68.
///
/// A [`GestureFrame::Cmd`] delegates STRAIGHT to [`apply_gesture`], whose signature
/// is untouched (it still has callers in `demo_scene.rs`, four test files
/// and an example, and none of them moved). A [`GestureFrame::RunPace`] runs the
/// belt-run fan-out below.
///
/// # Errors
/// Whatever [`apply_gesture`] returns for a command frame; for a run frame see
/// [`apply_run_pace`].
pub fn apply_gesture_frame(
    host: &mut Host,
    frame: GestureFrame,
    resolve: impl Fn(u64) -> Option<NodeId>,
) -> Result<(), CommandError> {
    match frame {
        GestureFrame::Cmd(cmd) => apply_gesture(host, cmd, resolve),
        GestureFrame::RunPace(run) => apply_run_pace(host, &run, resolve),
    }
}

/// Write ONE pace to EVERY belt in a run, under ONE action id, so a whole run is a
/// single `Ctrl+Z` (D-68-07 as corrected by D-68-16, 68-UI-SPEC FINDING 2).
///
/// # The seam, and why it is this one
/// [`Host::enqueue_action_group`] is the LIVE coalescing seam: the same one the
/// Undo/Redo arms above use. `Session::apply_under_action`, which `68-CONTEXT.md`
/// D-68-07 and `68-UI-SPEC.md` FINDING 2 both prescribe, is reachable only from
/// `fabrico-scenario` and tests: the running app goes `apply_gesture` ->
/// `enqueue_edit_with_new_action`, one FRESH action id per frame. A fan-out built on
/// the headless seam would pass its own tests green over an app that produces N undo
/// steps.
///
/// # VALIDATE ALL, THEN ENQUEUE: the ordering is the safety property
/// Every handle is resolved and every record validated into a local `Vec` BEFORE any
/// of them is enqueued, and the grouped enqueue is the LAST statement. So a refusal
/// on belt K of N leaves the edit log byte-identical and no belt at a new pace:
/// [`apply_gesture`]'s never-mutates-on-error contract becomes a DESIGNED property
/// for N records rather than one inherited from a single one. A `?` that escaped
/// mid-loop after a record had already been enqueued would be the half-applied run:
/// a user told the pace was refused, looking at a run running at two paces.
///
/// This arm RETURNS after the grouped enqueue (the Undo arm's shape at `:424-434`),
/// which is what keeps control away from `enqueue_edit_with_new_action` - the
/// N-undo-steps defect by construction.
///
/// # Errors
/// - [`CommandError::Malformed`] for an EMPTY belt list (so
///   [`Host::enqueue_action_group`]'s empty-group early return is never what a user
///   gesture gets) or one longer than
///   [`MAX_RUN_PACE_BELTS`](crate::sim_loop::MAX_RUN_PACE_BELTS).
/// - [`CommandError::UnknownNode`] if any handle resolves to nothing, or resolves to
///   a live node that is not a BELT. The `Configure` arm of `validate_normalize` is
///   deliberately kind-blind (a wrong-kind config folds to a panic-free no-op), so
///   the kind question is asked HERE - a run frame naming a Factory is a forged
///   handle list, not a no-op worth logging.
/// - Whatever `validate_normalize` returns for the per-belt `Configure`, notably
///   [`CommandError::ZeroBeltInterval`] for a zero interval.
fn apply_run_pace(
    host: &mut Host,
    run: &BeltRunPace,
    resolve: impl Fn(u64) -> Option<NodeId>,
) -> Result<(), CommandError> {
    // (0) The two shape refusals, BEFORE any per-belt work. An empty list is refused
    //     here rather than reaching `enqueue_action_group`, whose empty-group early
    //     return would silently answer Ok to a gesture that did nothing.
    if run.belts.is_empty() || run.belts.len() > MAX_RUN_PACE_BELTS {
        return Err(CommandError::Malformed);
    }

    // (1) Resolve + validate EVERY belt into a local group. Nothing is enqueued in
    //     this block, so the `?`s below are free of the half-applied-run hazard: the
    //     only mutator is the grouped enqueue after it.
    let group = {
        let adapter = HostGridLookup::new(host.core(), host.pending_edits(), resolve);
        let mut group: Vec<EditRecord> = Vec::with_capacity(run.belts.len());
        for &handle in &run.belts {
            let node = adapter.resolve(handle).ok_or(CommandError::UnknownNode)?;
            if adapter.kind_of(node) != Some(machine_kind::BELT) {
                return Err(CommandError::UnknownNode);
            }
            // `extend`, not `push`: `validate_normalize` answers a GROUP since 72-08. A
            // `Configure` is never one of the two paired arms, so this is always one
            // record - the extend is here so the run keeps working if that ever stops
            // being true, rather than silently dropping a leg.
            group.extend(validate_normalize(
                &adapter,
                GridCommand::Configure {
                    node: handle,
                    config: fabrico_protocol::MachineConfig::Belt {
                        ticks_per_slot: run.ticks_per_slot,
                    },
                },
            )?);
        }
        group
    };

    // (2) ONE action id for the whole run. `enqueue_action_group` stamps every record
    //     with the same `action`, which is what makes one `Ctrl+Z` restore all N.
    host.enqueue_action_group(group);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fabrico_core::command::{Command, ResultEvent};
    use fabrico_core::core::Core;
    use fabrico_core::edit::EditOp;
    use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
    use fabrico_core::persist::RedbStore;
    use fabrico_protocol::machine_kind;
    use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

    use crate::ledger::DispatchLedger;

    /// A real `Host` over tempfile redb stores (mirrors `project.rs` / `render_packet.rs`).
    fn test_host() -> (tempfile::TempDir, Host) {
        let dir = tempfile::tempdir().expect("tempdir");
        let core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: 7,
        });
        let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
        let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
        let host = Host::new(core, store, ledger, None).expect("open host");
        (dir, host)
    }

    /// The per-tick channels `tick_once` drains. Gestures no longer ride the ingress
    /// channel (they are EDIT-log records now), but `tick_once` still requires the
    /// three channel handles; the unused `cmd` receiver and `result` sender are
    /// dropped — these gesture folds emit no commands.
    #[allow(clippy::type_complexity)]
    fn channels() -> (
        UnboundedSender<EventPayload>,
        UnboundedReceiver<EventPayload>,
        UnboundedSender<Command>,
        UnboundedReceiver<ResultEvent>,
    ) {
        let (ingress_tx, ingress_rx) = unbounded_channel::<EventPayload>();
        let (cmd_tx, _cmd_rx) = unbounded_channel::<Command>();
        let (_res_tx, results_rx) = unbounded_channel::<ResultEvent>();
        (ingress_tx, ingress_rx, cmd_tx, results_rx)
    }

    /// The bytes a lone Delete of a docked Factory logs, captured ONCE at plan 86-05's start
    /// revision (a throwaway worktree, removed afterwards) and never regenerated:
    /// the postcard encoding of the logged `EditOp::Delete`, its capture included.
    const FIRST_DELETE_WITNESS: &[u8] = &[1, 1, 1, 2, 0, 0, 3, 3, 3, 0, 2, 3, 0, 0, 4, 2, 1, 1, 0, 2, 4, 2, 2, 0, 1, 1, 3, 6, 2, 0, 0, 8, 2, 0, 0, 10, 2, 0, 0, 2, 1, 1, 0, 3, 1, 0, 3, 1, 0, 2, 1, 0, 2, 0, 0, 0];

    /// THE FAST PATH IS UNCHANGED (plan 86-05). A Delete first in its group with nothing
    /// pending is captured from `host.core()` itself, with no scratch board, so the one-board
    /// rewrite must write exactly the record it wrote before: a Factory docked to a belt that
    /// is docked to a Sink, deleted alone, logs the witness bytes above.
    #[test]
    fn a_first_delete_with_nothing_pending_writes_the_same_capture() {
        let (_dir, mut host) = test_host();
        let (_ingress_tx, mut ingress_rx, cmd_tx, mut results_rx) = channels();
        let mut ids: Vec<NodeId> = Vec::new();
        let mut gesture = |host: &mut Host, ids: &[NodeId], cmd: GridCommand| {
            let table = ids.to_vec();
            apply_gesture(host, cmd, move |h| usize::try_from(h).ok().and_then(|i| table.get(i).copied()))
                .expect("the set-up gesture is accepted");
            host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("tick folds the gesture");
        };
        // A Factory at (0,0) (its Out, catalog index 1, at (2,1) faces E onto (3,1)), a Sink
        // at (6,1) (its In faces W onto (5,1)), and a belt (3,1) to (5,1) docked at both ends.
        gesture(&mut host, &ids, GridCommand::Place { kind: machine_kind::FACTORY, cell_x: 0, cell_y: 0 });
        ids.push(host.core().last_tick.placed[0]);
        gesture(&mut host, &ids, GridCommand::Place { kind: machine_kind::SINK, cell_x: 6, cell_y: 1 });
        ids.push(host.core().last_tick.placed[0]);
        gesture(&mut host, &ids, GridCommand::DrawBelt { cells: vec![(3, 1), (4, 1), (5, 1)] });
        ids.push(host.core().state.occupied((3, 1)).expect("the belt stands on (3,1)"));
        gesture(&mut host, &ids, GridCommand::Dock { belt: 2, endpoint: fabrico_protocol::BeltEnd::Tail, node: 0, port: 1 });
        gesture(&mut host, &ids, GridCommand::Dock { belt: 2, endpoint: fabrico_protocol::BeltEnd::Head, node: 1, port: 0 });
        assert_eq!(host.core().state.links_iter().count(), 2, "the belt is docked at both ends");
        assert!(host.pending_edits().is_empty(), "nothing is pending before the Delete");

        apply_gesture(&mut host, GridCommand::Delete { node: 0 }, |h| (h == 0).then_some(ids[0])).expect("the Delete is accepted");
        assert_eq!(host.pending_edits().len(), 1, "the Delete is the only record of its pass");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("tick folds the Delete");
        let op = host
            .logged_edits()
            .expect("read the edit log")
            .into_iter()
            .rev()
            .find(|r| matches!(r.op, EditOp::Delete { .. }))
            .expect("the Delete is logged")
            .op;
        let EditOp::Delete { captured, .. } = &op else { unreachable!("found by the Delete arm") };
        assert_eq!(captured.belts.len(), 1, "the capture lists the docked belt");
        let bytes = postcard::to_allocvec(&op).expect("the record encodes");
        assert_eq!(bytes.as_slice(), FIRST_DELETE_WITNESS, "a first Delete with nothing pending writes the bytes it wrote at plan 86-05's start revision");
    }

    #[test]
    fn place_drawbelt_delete_logs_edit() {
        // One gesture -> one RESOLVED EditRecord enqueued onto the EDIT log -> topology
        // (+ layout for Place) mutates after the tick folds it EDITS-FIRST. The gesture
        // is authoritative: it enters ONLY via the logged edit path, never a direct
        // state write and never the runtime event ingress (CMD-05).
        let (_dir, mut host) = test_host();
        let (_ingress_tx, mut ingress_rx, cmd_tx, mut results_rx) = channels();
        let no_handles = |_h: u64| None;

        // --- Place: mints a node + records its cell. ---
        let nodes_before = host.core().state.node_ids().count();
        let edits_before = host.logged_edits().expect("read edit-log").len();
        apply_gesture(
            &mut host,
            GridCommand::Place {
                kind: machine_kind::SOURCE,
                cell_x: 2,
                cell_y: 3,
            },
            no_handles,
        )
        .expect("a valid place is accepted");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("tick folds the logged Place edit");
        // Capture the first minted id now (mint order is only reliable from the
        // per-tick observation, not a later topology re-scan).
        let id0 = host.core().last_tick.placed[0];

        assert_eq!(
            host.core().state.node_ids().count(),
            nodes_before + 1,
            "the Place gesture minted exactly one node via the edits-first fold"
        );
        assert!(
            host.core().state.occupied((2, 3)).is_some(),
            "the placed cell is recorded in core GridState (SPAT-01 single source)"
        );
        let edits = host.logged_edits().expect("read edit-log");
        assert_eq!(
            edits.len(),
            edits_before + 1,
            "the gesture was logged as exactly one EditRecord (authoritative)"
        );
        assert!(
            edits.iter().any(|e| matches!(
                e.op,
                EditOp::Place {
                    cell_x: 2,
                    cell_y: 3,
                    ..
                }
            )),
            "the gesture logged a RESOLVED Place edit-record"
        );
        // The gesture rode the EDIT log, NEVER the runtime event ingress (CMD-05).
        assert!(
            host.logged_events().expect("read event-log").is_empty(),
            "a gesture enqueues no runtime event (it is an EditRecord, not an EventPayload)"
        );

        // --- A second Place (a distinct node alongside the drawn belt). ---
        apply_gesture(
            &mut host,
            GridCommand::Place {
                kind: machine_kind::SOURCE,
                cell_x: 4,
                cell_y: 3,
            },
            no_handles,
        )
        .expect("second place accepted");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("tick");
        let id1 = host.core().last_tick.placed[0];

        // Dense-handle resolver: 0 -> id0, 1 -> id1 (the frontend's view).
        let resolve = move |h: u64| match h {
            0 => Some(id0),
            1 => Some(id1),
            _ => None,
        };

        // --- DrawBelt (3,3): mints a belt via the edits-first fold (post-Wire model —
        //     belts come only from DrawBelt; geometry-only, no handle resolution). ---
        let nodes_before_belt = host.core().state.node_ids().count();
        let edits_before_belt = host.logged_edits().expect("read edit-log").len();
        apply_gesture(
            &mut host,
            GridCommand::DrawBelt { cells: vec![(3, 3)] },
            resolve,
        )
        .expect("a valid drawbelt is accepted");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("tick folds the logged DrawBelt edit");
        assert_eq!(
            host.core().state.node_ids().count(),
            nodes_before_belt + 1,
            "the DrawBelt gesture minted a belt via the edits-first fold"
        );
        let edits = host.logged_edits().expect("read edit-log");
        assert_eq!(
            edits.len(),
            edits_before_belt + 1,
            "the drawbelt was logged as exactly one EditRecord"
        );
        assert!(
            edits.iter().any(|e| matches!(e.op, EditOp::DrawBelt { .. })),
            "the drawbelt logged a RESOLVED DrawBelt edit-record (a belt has no cell — W1)"
        );

        // --- Delete node 1: removes it from the topology. ---
        let nodes_before_delete = host.core().state.node_ids().count();
        apply_gesture(&mut host, GridCommand::Delete { node: 1 }, resolve)
            .expect("a valid delete is accepted");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("tick folds the logged Delete edit");
        assert!(
            host.core().state.node_ids().count() < nodes_before_delete,
            "the Delete gesture removed the node via the edits-first fold"
        );
        let edits = host.logged_edits().expect("read edit-log");
        assert!(
            edits.iter().any(|e| matches!(e.op, EditOp::Delete { .. })),
            "the delete logged a RESOLVED Delete edit-record"
        );
    }

    #[test]
    fn reject_invalid() {
        // An invalid gesture (occupied / out-of-bounds / unknown-node) returns a
        // typed CommandError, enqueues NOTHING onto the edit-log, mutates no state,
        // and never panics (T-8-GESTURE-OPTIMISTIC: the host rejects before any edit
        // is enqueued, so the fold never sees it).
        let (_dir, mut host) = test_host();
        let (_ingress_tx, mut ingress_rx, cmd_tx, mut results_rx) = channels();
        let no_handles = |_h: u64| None;

        // Occupy (5, 5) with a valid place first.
        apply_gesture(
            &mut host,
            GridCommand::Place {
                kind: machine_kind::SOURCE,
                cell_x: 5,
                cell_y: 5,
            },
            no_handles,
        )
        .expect("first place accepted");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("tick");
        let edits_len = host.logged_edits().expect("read edit-log").len();

        // (a) Collision: a second place on (5, 5) is rejected, enqueues nothing (a
        //     1×1 machine is a single-cell footprint -> FootprintCollision).
        assert_eq!(
            apply_gesture(
                &mut host,
                GridCommand::Place {
                    kind: machine_kind::SOURCE,
                    cell_x: 5,
                    cell_y: 5,
                },
                no_handles,
            ),
            Err(CommandError::FootprintCollision),
            "a place onto an occupied cell is rejected"
        );
        assert_eq!(
            host.pending_edits().len(),
            0,
            "occupied reject enqueued no edit"
        );

        // (b) Out-of-bounds: a far-off cell is rejected.
        assert_eq!(
            apply_gesture(
                &mut host,
                GridCommand::Place {
                    kind: machine_kind::SOURCE,
                    cell_x: i32::MAX,
                    cell_y: 0,
                },
                no_handles,
            ),
            Err(CommandError::OutOfBounds),
            "a place outside the grid bound is rejected"
        );

        // (c) Unknown node: a delete of a handle that resolves to nothing is rejected.
        assert_eq!(
            apply_gesture(&mut host, GridCommand::Delete { node: 999 }, no_handles),
            Err(CommandError::UnknownNode),
            "a delete of an unresolved handle is rejected"
        );

        // None of the rejects logged anything: a fold tick leaves the edit-log
        // unchanged (the rejects enqueued no EditRecord).
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("tick");
        assert_eq!(
            host.logged_edits().expect("read edit-log").len(),
            edits_len,
            "the rejected gestures logged no edit-record"
        );
    }

    #[test]
    fn same_tick_same_cell_place_rejected() {
        // WR-01: two Place gestures targeting the SAME free cell within ONE tick's
        // drain loop (BEFORE tick_once folds them and the producer updates the layout)
        // must NOT both validate. The first is accepted and buffers its cell; the
        // second consults the pending-cell buffer, sees the cell already claimed THIS
        // tick, and is rejected as FootprintCollision — the SAME outcome the headless
        // GridSession produces by re-projecting after each apply (CMD-01). Without the
        // pending-cell-aware occupancy check both would pass against the stale (empty)
        // layout and stack on one cell (the TOCTOU that violates occupancy V5).
        let (_dir, mut host) = test_host();
        let no_handles = |_h: u64| None;

        apply_gesture(
            &mut host,
            GridCommand::Place {
                kind: machine_kind::SOURCE,
                cell_x: 8,
                cell_y: 8,
            },
            no_handles,
        )
        .expect("the first place on a free cell is accepted");

        // SAME tick, SAME cell — no tick_once / layout update between the two gestures.
        assert_eq!(
            apply_gesture(
                &mut host,
                GridCommand::Place {
                    kind: machine_kind::SOURCE,
                    cell_x: 8,
                    cell_y: 8,
                },
                no_handles,
            ),
            Err(CommandError::FootprintCollision),
            "the second same-cell Place THIS tick is rejected (enqueued-edit-aware occupancy)"
        );

        // Only the accepted Place enqueued an edit; the reject enqueued nothing — so
        // exactly one edit is pending this tick (no stacking on one cell).
        assert_eq!(
            host.pending_edits().len(),
            1,
            "only the accepted Place enqueued an edit (the reject enqueued nothing)"
        );
    }

    // (17-02: `rewire_occupied_output_port_rejected` removed — it exercised the node→node
    // Wire re-wire guard (WR-04 / PortOccupied), which was retired with GridCommand::Wire.
    // Belts now come only from DrawBelt; a belt end docks to exactly one port via Dock.)

    /// A monomorphic `resolve` fn item for the adapter (no handles resolve).
    fn none_resolve(_h: u64) -> Option<NodeId> {
        None
    }

    /// Plan 86-02 (EDIT 13): a pending `Place` is expanded at its OWN rotation. The
    /// re-Place of a Delete undo carries the turn the machine held, and the cells it will
    /// claim are the turned box's, so a 2 by 3 at rot 1 reads 3 wide and 2 deep.
    #[test]
    fn host_occupied_by_expands_a_pending_place_at_its_turn() {
        use fabrico_core::edit::EDIT_SCHEMA_VERSION;
        let (_dir, host) = test_host();
        let pending = vec![EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 0,
            tick: 0,
            action: 0,
            op: EditOp::Place {
                kind: machine_kind::ROUTER,
                cell_x: 0,
                cell_y: 0,
                w: 2,
                h: 3,
                ports: vec![],
                rot: 1,
            },
        }];
        let adapter = HostGridLookup::new(host.core(), &pending, none_resolve);
        assert!(adapter.occupied_by((2, 0)).is_some(), "the turned box reaches x 2");
        assert!(adapter.occupied_by((2, 1)).is_some(), "the turned box's far corner is (2,1)");
        assert!(adapter.occupied_by((0, 2)).is_none(), "the unturned row y 2 is free");
    }

    #[test]
    fn host_occupied_by_expands_pending_place_footprint() {
        // WR-01 multi-cell TOCTOU (Pitfall 6): the host's same-tick occupancy scan
        // expands each pending `Place`'s FULL footprint (its frozen w,h), not just the
        // anchor — so a same-tick overlap on a NON-anchor body cell is detected. Build
        // a HostGridLookup directly over a pending 2×3 Place (not yet folded) and prove
        // every body cell — anchor AND interior — reads occupied, while a cell outside
        // the rectangle stays free.
        use fabrico_core::edit::EDIT_SCHEMA_VERSION;
        let (_dir, host) = test_host();
        let pending = vec![EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 0,
            tick: 0,
            action: 0,
            op: EditOp::Place {
                kind: machine_kind::ROUTER,
                cell_x: 0,
                cell_y: 0,
                w: 2,
                h: 3,
                ports: vec![],
                rot: 0,
            },
        }];
        let adapter = HostGridLookup::new(host.core(), &pending, none_resolve);
        // The 2×3 footprint anchored at (0,0) covers x∈{0,1}, y∈{0,1,2}.
        assert!(adapter.occupied_by((0, 0)).is_some(), "anchor reads occupied");
        assert!(
            adapter.occupied_by((1, 1)).is_some(),
            "a NON-anchor interior cell reads occupied (full-footprint expansion)"
        );
        assert!(
            adapter.occupied_by((1, 2)).is_some(),
            "the far corner of the footprint reads occupied"
        );
        // Outside the rectangle is free.
        assert!(adapter.occupied_by((2, 0)).is_none(), "x past the width is free");
        assert!(adapter.occupied_by((0, 3)).is_none(), "y past the height is free");
        // The default boolean `occupied` agrees with occupied_by.
        assert!(adapter.occupied((1, 1)));
        assert!(!adapter.occupied((2, 0)));
    }

    #[test]
    fn host_occupied_by_matches_core_state_for_folded_grid() {
        // Parity with the headless GridViewLookup: with NO pending edits, the host's
        // occupied_by IS exactly core.state.occupied (both producers read the single
        // SPAT-01 authority) — the "one validation path, two producers" invariant.
        let (_dir, mut host) = test_host();
        let (_ingress_tx, mut ingress_rx, cmd_tx, mut results_rx) = channels();
        apply_gesture(
            &mut host,
            GridCommand::Place {
                kind: machine_kind::SOURCE,
                cell_x: 4,
                cell_y: 5,
            },
            none_resolve,
        )
        .expect("place a source");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("tick folds the place");
        let id = host.core().last_tick.placed[0];

        let no_pending: [EditRecord; 0] = [];
        let adapter = HostGridLookup::new(host.core(), &no_pending, none_resolve);
        assert_eq!(adapter.occupied_by((4, 5)), Some(id), "the folded cell is owned by its node");
        assert_eq!(
            adapter.occupied_by((4, 5)),
            host.core().state.occupied((4, 5)),
            "occupied_by delegates to the single core.state authority (parity)"
        );
        assert_eq!(adapter.occupied_by((9, 9)), None, "a free cell is unoccupied");
    }

    /// The first live node whose kind the headless lookup and the host lookup name
    /// differently, with both answers, or `None` when they agree for every live node
    /// (phase 86, WORK-06, D-07).
    ///
    /// The headless side is the session's own projection paired with the session's own
    /// core, exactly what `GridSession::apply` validates against. The host side is the
    /// adapter `apply_gesture` validates against, over this pass's pending edits. Called
    /// after a fold, so the pending buffer is empty and both read the same folded board.
    fn kind_disagreement(
        host: &Host,
        resolve: impl Fn(u64) -> Option<NodeId>,
    ) -> Option<(NodeId, Option<u8>, Option<u8>)> {
        let headless = host.session().view().lookup(host.session().core());
        let live = HostGridLookup::new(host.core(), host.pending_edits(), resolve);
        host.core().state.node_ids().find_map(|id| {
            let (h, l) = (headless.kind_of(id), live.kind_of(id));
            (h != l).then_some((id, h, l))
        })
    }

    #[test]
    fn kind_lookup_agrees_after_a_factory_becomes_a_handler() {
        // WORK-06 (phase 86, D-07): a Factory whose catalog ports are stripped and
        // replaced by an electrical In at index 0 and an electrical Out IS a Handler
        // (`is_handler_shape`). The host has always read that live; the headless lookup
        // read a kind byte cached at Place time and kept naming it FACTORY. Every fold
        // below is followed by the two-lookup comparison over every live node.
        use fabrico_core::state::Side;
        use fabrico_protocol::{port_medium, port_role};
        let (_dir, mut host) = test_host();
        let (_ingress_tx, mut ingress_rx, cmd_tx, mut results_rx) = channels();

        apply_gesture(
            &mut host,
            GridCommand::Place { kind: machine_kind::FACTORY, cell_x: 20, cell_y: 20 },
            none_resolve,
        )
        .expect("place the factory");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("fold the place");
        let f = host.core().last_tick.placed[0];
        let resolve = move |h: u64| (h == 0).then_some(f);
        assert_eq!(kind_disagreement(&host, resolve), None, "after Place FACTORY");

        // Strip the three catalog ports top-down (Fault 2, Out 1, In 0), as
        // `bless_fixtures.rs` scenario 07 does, so each index is still valid.
        for index in [2u16, 1, 0] {
            apply_gesture(&mut host, GridCommand::RemovePort { node: 0, index }, resolve)
                .expect("remove a catalog port");
            host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("fold the remove");
            assert_eq!(
                kind_disagreement(&host, resolve),
                None,
                "after RemovePort index {index}"
            );
        }

        apply_gesture(
            &mut host,
            GridCommand::AddPort {
                node: 0,
                role: port_role::IN,
                side: Side::W as u8,
                medium: port_medium::ELECTRICAL,
            },
            resolve,
        )
        .expect("add an electrical In");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("fold the add In");
        assert_eq!(kind_disagreement(&host, resolve), None, "after AddPort electrical In");

        apply_gesture(
            &mut host,
            GridCommand::AddPort {
                node: 0,
                role: port_role::OUT,
                side: Side::E as u8,
                medium: port_medium::ELECTRICAL,
            },
            resolve,
        )
        .expect("add an electrical Out");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("fold the add Out");
        assert_eq!(kind_disagreement(&host, resolve), None, "after AddPort electrical Out");
        let headless = host.session().view().lookup(host.session().core()).kind_of(f);
        let live = HostGridLookup::new(host.core(), host.pending_edits(), resolve).kind_of(f);
        assert_eq!(live, Some(machine_kind::HANDLER), "the host reads the port-edited Factory as a Handler");
        assert_eq!(headless, Some(machine_kind::HANDLER), "the headless lookup reads it as a Handler too");

        // A pending Delete: the host reads the node as gone before the fold (WR-01).
        apply_gesture(&mut host, GridCommand::Delete { node: 0 }, resolve).expect("delete the handler");
        assert_eq!(
            HostGridLookup::new(host.core(), host.pending_edits(), resolve).kind_of(f),
            None,
            "a node with a pending Delete has no kind host-side"
        );
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("fold the delete");
        assert_eq!(kind_disagreement(&host, resolve), None, "after the Delete folds");
        assert_eq!(
            host.session().view().lookup(host.session().core()).kind_of(f),
            None,
            "the deleted node is absent headless"
        );
        assert_eq!(
            HostGridLookup::new(host.core(), host.pending_edits(), resolve).kind_of(f),
            None,
            "the deleted node is absent host-side"
        );
    }

    /// Every kind byte `GridCommand::Place` accepts (`kind_has_catalog_arm` minus BELT,
    /// which is never placed).
    const PLACEABLE_KINDS: [u8; 10] = [
        machine_kind::SOURCE,
        machine_kind::FACTORY,
        machine_kind::TEE,
        machine_kind::BALANCER,
        machine_kind::ROUTER,
        machine_kind::MERGE,
        machine_kind::SINK,
        machine_kind::ENDPOINT,
        machine_kind::HANDLER,
        machine_kind::LABEL,
    ];

    /// One generated gesture. A node operand is an index into the live node list at the
    /// step it runs (taken modulo its length), turned into a handle by [`nth_live`].
    #[derive(Clone, Debug)]
    enum KindGesture {
        Place { kind: u8, x: i32, y: i32 },
        AddPort { node: usize, role: u8, side: u8, medium: u8 },
        RemovePort { node: usize, index: u16 },
        Rotate { node: usize, ccw: bool },
        Delete { node: usize },
        Undo,
        Redo,
    }

    /// A small window of cells (6 by 6 from (20, 20)), so 3 by 3 machines collide and a
    /// port edit lands on a live machine more often than not.
    fn kind_gesture() -> impl proptest::strategy::Strategy<Value = KindGesture> {
        use proptest::prelude::*;
        prop_oneof![
            3 => (proptest::sample::select(PLACEABLE_KINDS.to_vec()), 20i32..26, 20i32..26)
                .prop_map(|(kind, x, y)| KindGesture::Place { kind, x, y }),
            3 => (0usize..8, 0u8..3, 0u8..4, 0u8..2)
                .prop_map(|(node, role, side, medium)| KindGesture::AddPort { node, role, side, medium }),
            3 => (0usize..8, 0u16..6).prop_map(|(node, index)| KindGesture::RemovePort { node, index }),
            1 => (0usize..8, any::<bool>()).prop_map(|(node, ccw)| KindGesture::Rotate { node, ccw }),
            1 => (0usize..8).prop_map(|node| KindGesture::Delete { node }),
            1 => Just(KindGesture::Undo),
            1 => Just(KindGesture::Redo),
        ]
    }

    /// The handle a generated node index names: the live ids in `node_ids` order,
    /// position `i` taken as handle `i` (the [`nth_live`] resolve reads the same list).
    fn nth_live(ids: &[NodeId]) -> impl Fn(u64) -> Option<NodeId> + Copy + '_ {
        move |h: u64| usize::try_from(h).ok().and_then(|i| ids.get(i).copied())
    }

    proptest::proptest! {
        // Honor PROPTEST_CASES (CI's all-features line sets 1024); 256 locally.
        #![proptest_config(proptest::test_runner::Config::default())]

        /// WORK-06 (phase 86, D-07): after EVERY fold of ANY generated sequence of Place,
        /// AddPort, RemovePort, Rotate, Delete, Undo and Redo, the headless and the host
        /// lookups name the same kind for every live node. A refused gesture is skipped.
        ///
        /// WHAT IT CANNOT SEE (phase 86 review, IN-05). The comparison runs after the fold,
        /// when the pending buffer is empty, so the host lookup reads the same folded board
        /// the headless one reads. It guards against a reintroduced kind CACHE, which is what
        /// WORK-06 asked for. It does not grade the window in which the two differ by design:
        /// port edits still pending in the same drain pass, which only the host lookup sees.
        #[test]
        fn kind_lookup_agrees_after_every_generated_edit(
            gestures in proptest::collection::vec(kind_gesture(), 1..=12)
        ) {
            let (_dir, mut host) = test_host();
            let (_ingress_tx, mut ingress_rx, cmd_tx, mut results_rx) = channels();
            for (step, g) in gestures.iter().enumerate() {
                let ids: Vec<NodeId> = host.core().state.node_ids().collect();
                let pick = |i: usize| (!ids.is_empty()).then(|| (i % ids.len()) as u64);
                let cmd = match *g {
                    KindGesture::Place { kind, x, y } => {
                        Some(GridCommand::Place { kind, cell_x: x, cell_y: y })
                    }
                    KindGesture::AddPort { node, role, side, medium } => {
                        pick(node).map(|node| GridCommand::AddPort { node, role, side, medium })
                    }
                    KindGesture::RemovePort { node, index } => {
                        pick(node).map(|node| GridCommand::RemovePort { node, index })
                    }
                    KindGesture::Rotate { node, ccw } => {
                        pick(node).map(|node| GridCommand::Rotate { node, ccw })
                    }
                    KindGesture::Delete { node } => pick(node).map(|node| GridCommand::Delete { node }),
                    KindGesture::Undo => Some(GridCommand::Undo),
                    KindGesture::Redo => Some(GridCommand::Redo),
                };
                let Some(cmd) = cmd else { continue };
                if apply_gesture(&mut host, cmd, nth_live(&ids)).is_err() {
                    continue;
                }
                host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("the tick folds");
                let ids: Vec<NodeId> = host.core().state.node_ids().collect();
                proptest::prop_assert_eq!(
                    kind_disagreement(&host, nth_live(&ids)),
                    None,
                    "step {} ({:?}): the headless and host lookups name different kinds",
                    step,
                    g
                );
            }
        }
    }

    /// A Factory placed at (20,20), turned `rot` quarter turns, grown to 3 outputs, every
    /// gesture folded on its own tick. Returns the host's channels-free pieces and the id.
    fn three_output_factory(
        host: &mut Host,
        rot: u8,
        ingress_rx: &mut UnboundedReceiver<EventPayload>,
        results_rx: &mut UnboundedReceiver<ResultEvent>,
        cmd_tx: &UnboundedSender<Command>,
    ) -> NodeId {
        apply_gesture(
            host,
            GridCommand::Place { kind: machine_kind::FACTORY, cell_x: 20, cell_y: 20 },
            none_resolve,
        )
        .expect("place the factory");
        host.tick_once(ingress_rx, results_rx, cmd_tx).expect("fold the place");
        let f = host.core().last_tick.placed[0];
        let resolve = move |h: u64| (h == 0).then_some(f);
        for _ in 0..rot {
            apply_gesture(host, GridCommand::Rotate { node: 0, ccw: false }, resolve)
                .expect("turn the undocked factory");
            host.tick_once(ingress_rx, results_rx, cmd_tx).expect("fold the turn");
        }
        for _ in 0..2 {
            apply_gesture(host, add_out(), resolve).expect("an add on clear floor");
            host.tick_once(ingress_rx, results_rx, cmd_tx).expect("fold the add");
        }
        f
    }

    /// The panel's `+ Add output` on handle 0.
    fn add_out() -> GridCommand {
        GridCommand::AddPort {
            node: 0,
            role: fabrico_protocol::port_role::OUT,
            side: fabrico_core::state::Side::E as u8,
            medium: fabrico_protocol::port_medium::MECHANICAL,
        }
    }

    /// Plan 74.1-23 (review WR-01, round 3): with a growing `AddPort` PENDING, the adapter
    /// answers the GROWN machine, the same answers the core gives once the add folds: the
    /// footprint, the shifted anchor at rot 1, the port list and the cells the growth claims.
    /// RED at the start revision: the adapter answered the pre-add 3x3 at the old anchor.
    #[test]
    fn host_adapter_sees_a_pending_growing_add_at_rot_1() {
        let (_dir, mut host) = test_host();
        let (_ingress_tx, mut ingress_rx, cmd_tx, mut results_rx) = channels();
        let f = three_output_factory(&mut host, 1, &mut ingress_rx, &mut results_rx, &cmd_tx);
        let resolve = move |h: u64| (h == 0).then_some(f);
        assert_eq!(
            host.core().state.footprint_of(f),
            Some(Footprint { w: 3, h: 3, rot: 1 }),
            "measured: a turned 3-output Factory is 3x3"
        );

        apply_gesture(&mut host, add_out(), resolve).expect("the growing add is accepted");
        let (fp, anchor, ports, claimed) = {
            let adapter = HostGridLookup::new(host.core(), host.pending_edits(), none_resolve);
            let fp = adapter.footprint_of(f);
            let anchor = adapter.cell_of(f);
            let ports = adapter.ports_of(f).map(<[Port]>::to_vec);
            let claimed: Vec<Option<NodeId>> =
                (16..26).flat_map(|x| (16..26).map(move |y| (x, y))).map(|c| adapter.occupied_by(c)).collect();
            (fp, anchor, ports, claimed)
        };

        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("fold the add");
        let core = host.core();
        assert_eq!(fp, core.state.footprint_of(f), "pending footprint == folded footprint (3x4)");
        assert_eq!(anchor, core.state.cell_of(f), "pending anchor == folded anchor (shifted at rot 1)");
        assert_ne!(anchor, Some((20, 20)), "measured: the turned add moved the anchor");
        assert_eq!(ports.as_deref(), core.state.ports_of(f), "pending ports == folded ports");
        let folded: Vec<Option<NodeId>> =
            (16..26).flat_map(|x| (16..26).map(move |y| (x, y))).map(|c| core.state.occupied(c)).collect();
        assert_eq!(claimed, folded, "pending occupancy == folded occupancy, growth cells included");
    }

    /// Phase 76, plan 76-07 (CR-02): with a label resize PENDING, the adapter answers the
    /// RESIZED label, the same answers the core gives once the Configure folds: the
    /// footprint, the anchor and every cell of the window. ONE tuple per phase, so a red
    /// prints the pending answer beside the folded one.
    ///
    /// Phase 1: a 4 by 1 label grown to 6 by 2, pending. Phase 2: from a FOLDED 4 by 1
    /// (a box different from the pending grow, asserted as a measured premise), a grow to
    /// 6 by 2 and a shrink to 3 by 1 pending together, the two Applies of a paused board.
    /// The window holds the grown-only cells (x 14 to 15 on row 10, x 10 to 15 on row
    /// 11), so a replay that frees the shrink's pre-record box from the FOLDED box instead
    /// of the box the grow leaves keeps them claimed and reddens phase 2.
    ///
    /// RED at the start revision: the adapter treated every Configure as cell-neutral and
    /// answered the folded `Footprint { w: 4, h: 1, rot: 0 }` beside the folded 6 by 2.
    #[test]
    fn host_adapter_sees_a_pending_label_resize() {
        let (_dir, mut host) = test_host();
        let (_ingress_tx, mut ingress_rx, cmd_tx, mut results_rx) = channels();
        apply_gesture(
            &mut host,
            GridCommand::Place { kind: machine_kind::LABEL, cell_x: 10, cell_y: 10 },
            none_resolve,
        )
        .expect("a label places on clear floor");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("fold the place");
        let label = host.core().last_tick.placed[0];
        let resolve = move |h: u64| (h == 0).then_some(label);
        let resize = |w: u16, h: u16| GridCommand::Configure {
            node: 0,
            config: fabrico_protocol::MachineConfig::Label { text: "Intake".to_owned(), colour: 3, w, h },
        };
        let window = || (8..=18).flat_map(|x| (8..=14).map(move |y| (x, y)));
        let pending_view = |host: &Host| {
            let adapter = HostGridLookup::new(host.core(), host.pending_edits(), none_resolve);
            let cells: Vec<Option<NodeId>> = window().map(|c| adapter.occupied_by(c)).collect();
            (adapter.footprint_of(label), adapter.cell_of(label), cells)
        };
        let folded_view = |host: &Host| {
            let core = host.core();
            let cells: Vec<Option<NodeId>> = window().map(|c| core.state.occupied(c)).collect();
            (core.state.footprint_of(label), core.state.cell_of(label), cells)
        };

        // Phase 1: one pending grow.
        apply_gesture(&mut host, resize(6, 2), resolve).expect("the grow onto clear floor is accepted");
        let pending = pending_view(&host);
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("fold the grow");
        assert_eq!(pending, folded_view(&host), "phase 1: pending (footprint, anchor, occupancy) == folded (6 by 2)");

        // Phase 2: back to a folded 4 by 1, then a grow and a shrink pending together.
        apply_gesture(&mut host, resize(4, 1), resolve).expect("the shrink back to 4 by 1 is accepted");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("fold the shrink");
        assert_eq!(
            host.core().state.footprint_of(label),
            Some(Footprint { w: 4, h: 1, rot: 0 }),
            "measured: phase 2 starts from a folded 4 by 1, not the 6 by 2 the pending grow asks for"
        );
        apply_gesture(&mut host, resize(6, 2), resolve).expect("the pending grow is accepted");
        apply_gesture(&mut host, resize(3, 1), resolve).expect("the pending shrink is accepted");
        assert_eq!(host.pending_edits().len(), 2, "measured: two resizes of one label pend in one pass");
        let pending = pending_view(&host);
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("fold both resizes");
        assert_eq!(
            pending,
            folded_view(&host),
            "phase 2: a grow then a shrink pending together == the folded 3 by 1, grown-only cells free"
        );
    }

    /// Plan 74.1-23: a SECOND same-tick growing add is collision-checked against the box
    /// the first one grows, so a belt on the second add's growth row refuses it
    /// `GrowCoversBelt`, and the board still passes the trust gate after the tick.
    /// RED at the start revision: the second add was checked against the pre-batch 3x3,
    /// found row 3 clear and was accepted, and the fold grew the box over the belt.
    #[test]
    fn a_second_same_tick_add_whose_growth_holds_a_belt_is_refused() {
        use fabrico_core::snapshot::{restore, snapshot};
        let (_dir, mut host) = test_host();
        let (_ingress_tx, mut ingress_rx, cmd_tx, mut results_rx) = channels();
        let f = three_output_factory(&mut host, 0, &mut ingress_rx, &mut results_rx, &cmd_tx);
        let resolve = move |h: u64| (h == 0).then_some(f);
        // The 3x3 box covers y 20..=22; the first add grows row y=23, the second y=24.
        apply_gesture(
            &mut host,
            GridCommand::DrawBelt { cells: vec![(20, 24), (21, 24), (22, 24)] },
            none_resolve,
        )
        .expect("a belt on row y=24");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("fold the belt");

        apply_gesture(&mut host, add_out(), resolve).expect("the first add grows onto clear y=23");
        assert_eq!(
            apply_gesture(&mut host, add_out(), resolve),
            Err(CommandError::GrowCoversBelt),
            "the second add would grow onto the belt at y=24"
        );
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("fold the tick");
        assert_eq!(
            host.core().state.footprint_of(f),
            Some(Footprint { w: 3, h: 4, rot: 0 }),
            "only the first add folded"
        );
        restore(&snapshot(host.core())).expect("the board passes the trust gate");
    }

    /// REVIEW ROUND 4 IN-01's board, MEASURED. A Factory `f` at (20,20) with
    /// `[In, Out_a (mech), Fault, Out_b (mech), Out_c (electrical)]`: a belt's first tile
    /// docked on `Out_b` (catalog 3, Out key 1) and a wire leaving `Out_c` (catalog 4) for a
    /// second Factory's electrical In. Every gesture folds on its own tick. Returns
    /// `(f, the target, the belt)`; handle 0 is `f`, 1 the target, 2 the belt.
    fn wired_out_above_a_removed_one(
        host: &mut Host,
        ingress_rx: &mut UnboundedReceiver<EventPayload>,
        results_rx: &mut UnboundedReceiver<ResultEvent>,
        cmd_tx: &UnboundedSender<Command>,
    ) -> (NodeId, NodeId, NodeId) {
        use fabrico_core::state::{Medium, Role, port_world, unit_delta};
        let fold = |host: &mut Host, ingress_rx: &mut UnboundedReceiver<EventPayload>, results_rx: &mut UnboundedReceiver<ResultEvent>| {
            host.tick_once(ingress_rx, results_rx, cmd_tx).expect("fold one gesture");
        };
        for x in [20, 30] {
            apply_gesture(host, GridCommand::Place { kind: machine_kind::FACTORY, cell_x: x, cell_y: 20 }, none_resolve)
                .expect("place a factory");
            fold(host, ingress_rx, results_rx);
        }
        let f = host.core().state.occupied((20, 20)).expect("f at (20,20)");
        let t = host.core().state.occupied((30, 20)).expect("the target at (30,20)");
        let two = move |h: u64| [f, t].get(h as usize).copied();
        let add = |role: u8, side: fabrico_core::state::Side, medium: u8, node: u64| GridCommand::AddPort {
            node,
            role,
            side: side as u8,
            medium,
        };
        use fabrico_core::state::Side;
        use fabrico_protocol::{port_medium, port_role};
        for cmd in [
            add(port_role::OUT, Side::E, port_medium::MECHANICAL, 0),
            add(port_role::OUT, Side::E, port_medium::ELECTRICAL, 0),
            add(port_role::IN, Side::W, port_medium::ELECTRICAL, 1),
        ] {
            apply_gesture(host, cmd, two).expect("a port add on clear floor");
            fold(host, ingress_rx, results_rx);
        }
        let fports = host.core().state.ports_of(f).expect("f's ports").to_vec();
        assert_eq!(
            fports.iter().map(|p| (p.role, p.medium)).collect::<Vec<_>>(),
            vec![
                (Role::In, Medium::Mechanical),
                (Role::Out, Medium::Mechanical),
                (Role::Fault, Medium::Mechanical),
                (Role::Out, Medium::Mechanical),
                (Role::Out, Medium::Electrical),
            ],
            "MEASURED: f is [In, Out_a, Fault, Out_b, Out_c (electrical)]"
        );
        let t_in = host
            .core()
            .state
            .ports_of(t)
            .expect("the target's ports")
            .iter()
            .position(|p| p.role == Role::In && p.medium == Medium::Electrical)
            .expect("the target has an electrical In");
        // The belt leaves Out_b's doorstep eastward, its first tile ON the doorstep.
        let fp = host.core().state.footprint_of(f).expect("f's footprint");
        let (pcell, side) = port_world((20, 20), fp.w, fp.h, fp.rot, &fports[3]);
        let (dx, dy) = unit_delta(side);
        let door = (pcell.0 + dx, pcell.1 + dy);
        apply_gesture(host, GridCommand::DrawBelt { cells: vec![door, (door.0 + dx, door.1 + dy)] }, none_resolve)
            .expect("a belt off Out_b's doorstep");
        fold(host, ingress_rx, results_rx);
        let belt = host.core().state.occupied(door).expect("the belt's first tile");
        let three = move |h: u64| [f, t, belt].get(h as usize).copied();
        apply_gesture(
            host,
            GridCommand::Dock { belt: 2, endpoint: fabrico_protocol::BeltEnd::Tail, node: 0, port: 3 },
            three,
        )
        .expect("the belt docks on Out_b");
        fold(host, ingress_rx, results_rx);
        apply_gesture(
            host,
            GridCommand::DrawWire { from_node: 0, from_port: 4, to_node: 1, to_port: u16::try_from(t_in).expect("fits") },
            three,
        )
        .expect("a wire from Out_c");
        fold(host, ingress_rx, results_rx);
        assert_eq!(host.core().state.link_target((f, 1)), Some((belt, 0)), "MEASURED: Out key 1 feeds the belt");
        (f, t, belt)
    }

    /// Every occupancy answer the adapter gives about `f` after the pending edits: per
    /// catalog index, whether a wire leaves it and whether a wire touches it; per Out key and
    /// the fault sentinel, whether a link leaves it; and the node's kind byte.
    fn occupancy_of<V: GridLookup>(view: &V, f: NodeId, ports: usize, outs: u16) -> (Vec<(bool, bool)>, Vec<bool>, Option<u8>) {
        let catalog = (0..u16::try_from(ports + 1).expect("fits"))
            .map(|k| (view.wire_from_port_exists((f, k)), view.wire_touches_port((f, k))))
            .collect();
        let links = (0..=outs)
            .chain([fabrico_core::fault::FAULT_PORT])
            .map(|k| view.link_exists((f, k)))
            .collect();
        (catalog, links, view.kind_of(f))
    }

    /// The same answers read off the FOLDED core, the authority the adapter must agree with.
    fn folded_occupancy(core: &Core, f: NodeId, ports: usize, outs: u16) -> (Vec<(bool, bool)>, Vec<bool>, Option<u8>) {
        let wires: Vec<(NodeId, u16, NodeId, u16)> = core
            .state
            .node_ids()
            .filter_map(|id| match core.state.node(id) {
                Some(Node::Wire(w)) => Some((w.from.0, w.from.1, w.to.0, w.to.1)),
                _ => None,
            })
            .collect();
        let catalog = (0..u16::try_from(ports + 1).expect("fits"))
            .map(|k| {
                (
                    wires.iter().any(|w| (w.0, w.1) == (f, k)),
                    wires.iter().any(|w| (w.0, w.1) == (f, k) || (w.2, w.3) == (f, k)),
                )
            })
            .collect();
        let links = (0..=outs)
            .chain([fabrico_core::fault::FAULT_PORT])
            .map(|k| core.state.link_target((f, k)).is_some())
            .collect();
        let kind = core.state.node(f).map(|n| kind_byte(n, core.state.ports_of(f)));
        (catalog, links, kind)
    }

    /// REVIEW ROUND 4 IN-01, the review's scenario: ONE pass holds `RemovePort` of an earlier
    /// Out (catalog 1) and then a `DrawWire` from catalog 3, where the wired `Out_c` (catalog 4)
    /// sits once the removal folds. The adapter's port list already reads post-removal
    /// numbering, so its occupancy must too: the draw is refused `PortOccupied`. RED at the
    /// start revision of plan 74.1-32: `wire_from_port` still read the wire at catalog 4, the
    /// draw was accepted, and the fold minted a second wire out of one Out (dead topology).
    #[test]
    fn a_draw_from_the_index_a_wired_out_moves_to_in_the_same_pass_is_refused() {
        let (_dir, mut host) = test_host();
        let (_ingress_tx, mut ingress_rx, cmd_tx, mut results_rx) = channels();
        let (f, t, belt) = wired_out_above_a_removed_one(&mut host, &mut ingress_rx, &mut results_rx, &cmd_tx);
        let three = move |h: u64| [f, t, belt].get(h as usize).copied();
        let t_in = host
            .core()
            .state
            .ports_of(t)
            .expect("ports")
            .iter()
            .position(|p| p.medium == fabrico_core::state::Medium::Electrical)
            .expect("electrical In");

        apply_gesture(&mut host, GridCommand::RemovePort { node: 0, index: 1 }, three)
            .expect("Out_a carries nothing, so its removal is accepted");
        assert_eq!(
            apply_gesture(
                &mut host,
                GridCommand::DrawWire { from_node: 0, from_port: 3, to_node: 1, to_port: u16::try_from(t_in).expect("fits") },
                three,
            ),
            Err(CommandError::PortOccupied),
            "catalog 3 is the wired Out_c once the removal folds: a second wire out of it is refused"
        );
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("fold the pass");
        let wires_from_f = host
            .core()
            .state
            .node_ids()
            .filter(|&id| matches!(host.core().state.node(id), Some(Node::Wire(w)) if w.from.0 == f))
            .count();
        assert_eq!(wires_from_f, 1, "one wire leaves f, re-keyed to catalog 3 by the fold");
    }

    /// REVIEW ROUND 4 IN-01, THE COMPARISON PIN: with pending port edits, every occupancy
    /// answer the adapter gives about the edited node equals the answer the folded core gives
    /// once those edits fold, so the adapter's mirror of the fold's re-key cannot drift from
    /// it. Two phases on one board: a pending `RemovePort` of `Out_a` (every key above it
    /// shifts down: the wire 4 -> 3, the belt's Out key 1 -> 0), then, after it folds, the
    /// pending `AddPort` its Undo writes at catalog 1 (every key at or above it shifts back
    /// up). RED at the start revision of plan 74.1-32 on the wire and link rows.
    #[test]
    fn the_adapter_occupancy_agrees_with_the_fold_across_pending_port_edits() {
        let (_dir, mut host) = test_host();
        let (_ingress_tx, mut ingress_rx, cmd_tx, mut results_rx) = channels();
        let (f, t, belt) = wired_out_above_a_removed_one(&mut host, &mut ingress_rx, &mut results_rx, &cmd_tx);
        let three = move |h: u64| [f, t, belt].get(h as usize).copied();

        // Phase 1: a pending RemovePort of Out_a.
        apply_gesture(&mut host, GridCommand::RemovePort { node: 0, index: 1 }, three).expect("remove Out_a");
        let predicted = {
            let adapter = HostGridLookup::new(host.core(), host.pending_edits(), none_resolve);
            occupancy_of(&adapter, f, 5, 3)
        };
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("fold the removal");
        let folded = folded_occupancy(host.core(), f, 5, 3);
        assert_eq!(predicted, folded, "removal: the adapter's occupancy == the folded occupancy");
        assert_eq!(folded.0[3], (true, true), "MEASURED: the wire now leaves catalog 3");
        assert!(folded.1[0], "MEASURED: the belt now hangs on Out key 0");

        // Phase 2: the Undo's pending AddPort of Out_a back at catalog 1.
        apply_gesture(&mut host, GridCommand::Undo, three).expect("undo the removal");
        assert!(
            host.pending_edits().iter().any(|e| matches!(e.op, EditOp::AddPort { index: 1, .. })),
            "MEASURED: the undo's inverse is an AddPort at catalog 1"
        );
        let predicted = {
            let adapter = HostGridLookup::new(host.core(), host.pending_edits(), none_resolve);
            occupancy_of(&adapter, f, 5, 3)
        };
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("fold the undo");
        let folded = folded_occupancy(host.core(), f, 5, 3);
        assert_eq!(predicted, folded, "re-insert: the adapter's occupancy == the folded occupancy");
        assert_eq!(folded.0[4], (true, true), "MEASURED: the wire is back on catalog 4");
        assert!(folded.1[1], "MEASURED: the belt is back on Out key 1");

        // Phase 3 (plan 74.1-35, review round 5 WR-02): pending DOCK and UNLINK rows. In one
        // pass: an Unlink of the belt's Tail dock on Out_b, a Tail dock of a new belt onto
        // Out_a (a machine Out), a Tail dock onto a belt's end, and a Head dock of a belt
        // onto another belt's start. Every link source they touch must read the same
        // before and after the fold.
        let (door_a, step_a) = out_doorstep(&host, f, 1);
        let p = folded_belt(
            &mut host,
            &[door_a, (door_a.0 + step_a.0, door_a.1 + step_a.1)],
            &mut ingress_rx,
            &mut results_rx,
            &cmd_tx,
        );
        let (a, d, _e) = review_board(&mut host, &mut ingress_rx, &mut results_rx, &cmd_tx);
        let (b, x, _y) = head_board(&mut host, &mut ingress_rx, &mut results_rx, &cmd_tx);
        let ids = [f, t, belt, a, d, b, x, p];
        let all = move |h: u64| ids.get(h as usize).copied();
        apply_gesture(
            &mut host,
            GridCommand::Unlink { belt: 2, endpoint: fabrico_protocol::BeltEnd::Tail, node: 0, port: 3 },
            all,
        )
        .expect("unlink the belt from Out_b");
        apply_gesture(
            &mut host,
            GridCommand::Dock { belt: 7, endpoint: fabrico_protocol::BeltEnd::Tail, node: 0, port: 1 },
            all,
        )
        .expect("a Tail dock onto Out_a, a machine Out");
        apply_gesture(
            &mut host,
            GridCommand::Dock { belt: 4, endpoint: fabrico_protocol::BeltEnd::Tail, node: 3, port: 1 },
            all,
        )
        .expect("a Tail dock onto a belt's end");
        apply_gesture(
            &mut host,
            GridCommand::Dock { belt: 5, endpoint: fabrico_protocol::BeltEnd::Head, node: 6, port: 0 },
            all,
        )
        .expect("a Head dock onto a belt's start");
        let sources = [a, b, d, belt, p, x];
        let predicted = {
            let adapter = HostGridLookup::new(host.core(), host.pending_edits(), none_resolve);
            (occupancy_of(&adapter, f, 5, 3), sources.map(|n| adapter.link_exists((n, 0))))
        };
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("fold the pass");
        let folded = (
            folded_occupancy(host.core(), f, 5, 3),
            sources.map(|n| host.core().state.link_target((n, 0)).is_some()),
        );
        assert_eq!(predicted, folded, "docks and unlink: the adapter's occupancy == the folded occupancy");
        assert!(folded.0.1[0], "MEASURED: the new belt hangs on Out key 0");
        assert!(!folded.0.1[1], "MEASURED: Out key 1 is free after the unlink");
        assert!(folded.1[0] && folded.1[1], "MEASURED: the belt end and the Head carrier are joined");
    }

    // REVIEW ROUND 5 WR-02 (plan 74.1-35): `link_exists` REPLAYS THIS PASS'S PENDING DOCKS AND
    // UNLINKS. `fold_dock` links with a bare insert, so a second Dock naming the same link
    // source in one drain pass replaced the first: both answered Ok and the first join was
    // gone with no word. The path is a real one: plan 74.1-30's owed Docks for belts drawn
    // while paused are all sent when the same echo packet arrives after Play.

    /// Draw a belt and fold it, returning its id.
    fn folded_belt(
        host: &mut Host,
        cells: &[(i32, i32)],
        ingress_rx: &mut UnboundedReceiver<EventPayload>,
        results_rx: &mut UnboundedReceiver<ResultEvent>,
        cmd_tx: &UnboundedSender<Command>,
    ) -> NodeId {
        apply_gesture(host, GridCommand::DrawBelt { cells: cells.to_vec() }, none_resolve).expect("draw a belt");
        host.tick_once(ingress_rx, results_rx, cmd_tx).expect("fold the belt");
        host.core().state.occupied(cells[0]).expect("the belt's first tile")
    }

    /// The review's board: A (1,5)-(3,5) running east, D (3,4)-(3,3) and E (3,6)-(3,7), D and
    /// E undocked with their first tiles beside A's end. Each belt folds on its own tick.
    fn review_board(
        host: &mut Host,
        ingress_rx: &mut UnboundedReceiver<EventPayload>,
        results_rx: &mut UnboundedReceiver<ResultEvent>,
        cmd_tx: &UnboundedSender<Command>,
    ) -> (NodeId, NodeId, NodeId) {
        let a = folded_belt(host, &[(1, 5), (2, 5), (3, 5)], ingress_rx, results_rx, cmd_tx);
        let d = folded_belt(host, &[(3, 4), (3, 3)], ingress_rx, results_rx, cmd_tx);
        let e = folded_belt(host, &[(3, 6), (3, 7)], ingress_rx, results_rx, cmd_tx);
        (a, d, e)
    }

    /// A Head carrier B (1,8)-(3,8) running east and two free targets whose starts sit beside
    /// B's end: X (4,8)-(5,8) and Y (3,9)-(3,10).
    fn head_board(
        host: &mut Host,
        ingress_rx: &mut UnboundedReceiver<EventPayload>,
        results_rx: &mut UnboundedReceiver<ResultEvent>,
        cmd_tx: &UnboundedSender<Command>,
    ) -> (NodeId, NodeId, NodeId) {
        let b = folded_belt(host, &[(1, 8), (2, 8), (3, 8)], ingress_rx, results_rx, cmd_tx);
        let x = folded_belt(host, &[(4, 8), (5, 8)], ingress_rx, results_rx, cmd_tx);
        let y = folded_belt(host, &[(3, 9), (3, 10)], ingress_rx, results_rx, cmd_tx);
        (b, x, y)
    }

    /// The doorstep cell of `node`'s catalog port `idx` and the unit step pointing away from it.
    fn out_doorstep(host: &Host, node: NodeId, idx: usize) -> ((i32, i32), (i32, i32)) {
        use fabrico_core::state::{port_world, unit_delta};
        let state = &host.core().state;
        let ports = state.ports_of(node).expect("the machine's ports");
        let fp = state.footprint_of(node).expect("the machine's footprint");
        let anchor = state.cell_of(node).expect("the machine's anchor");
        let (pcell, side) = port_world(anchor, fp.w, fp.h, fp.rot, &ports[idx]);
        let step = unit_delta(side);
        ((pcell.0 + step.0, pcell.1 + step.1), step)
    }

    /// The catalog indices of `node`'s mechanical Outs, in order.
    fn mechanical_outs(host: &Host, node: NodeId) -> Vec<usize> {
        use fabrico_core::state::{Medium, Role};
        host.core()
            .state
            .ports_of(node)
            .expect("the machine's ports")
            .iter()
            .enumerate()
            .filter(|(_, p)| p.role == Role::Out && p.medium == Medium::Mechanical)
            .map(|(i, _)| i)
            .collect()
    }

    /// WR-02, the review's own case: D's Tail dock then E's Tail dock onto A's end, no tick
    /// between. The second is refused with the existing occupancy refusal and the first join
    /// survives the fold. RED at the start revision: both answered Ok and A fed E.
    #[test]
    fn two_same_pass_tail_docks_onto_one_belt_end_refuse_the_second() {
        let (_dir, mut host) = test_host();
        let (_ingress_tx, mut ingress_rx, cmd_tx, mut results_rx) = channels();
        let (a, d, e) = review_board(&mut host, &mut ingress_rx, &mut results_rx, &cmd_tx);
        let ids = [a, d, e];
        let resolve = move |h: u64| ids.get(h as usize).copied();

        apply_gesture(
            &mut host,
            GridCommand::Dock { belt: 1, endpoint: fabrico_protocol::BeltEnd::Tail, node: 0, port: 1 },
            resolve,
        )
        .expect("D joins A's end");
        assert_eq!(
            apply_gesture(
                &mut host,
                GridCommand::Dock { belt: 2, endpoint: fabrico_protocol::BeltEnd::Tail, node: 0, port: 1 },
                resolve,
            ),
            Err(CommandError::BeltEndTaken),
            "E's join onto the same end in the same pass is refused: that belt end is already joined"
        );
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("fold the pass");
        assert_eq!(host.core().state.link_target((a, 0)), Some((d, 0)), "A's end still feeds D");
    }

    /// WR-02, the Head direction: one belt's Head docked onto two free starts in one pass.
    #[test]
    fn two_same_pass_head_docks_of_one_belt_refuse_the_second() {
        let (_dir, mut host) = test_host();
        let (_ingress_tx, mut ingress_rx, cmd_tx, mut results_rx) = channels();
        let (b, x, y) = head_board(&mut host, &mut ingress_rx, &mut results_rx, &cmd_tx);
        let ids = [b, x, y];
        let resolve = move |h: u64| ids.get(h as usize).copied();

        apply_gesture(
            &mut host,
            GridCommand::Dock { belt: 0, endpoint: fabrico_protocol::BeltEnd::Head, node: 1, port: 0 },
            resolve,
        )
        .expect("B's end joins X");
        assert_eq!(
            apply_gesture(
                &mut host,
                GridCommand::Dock { belt: 0, endpoint: fabrico_protocol::BeltEnd::Head, node: 2, port: 0 },
                resolve,
            ),
            Err(CommandError::BeltEndTaken),
            "B's end joining Y in the same pass is refused: that belt end is already joined"
        );
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("fold the pass");
        assert_eq!(host.core().state.link_target((b, 0)), Some((x, 0)), "B still feeds X");
    }

    /// WR-02, the Unlink mirror: an Unlink of A's end link, then a Dock onto that end, in one
    /// pass. The end is free by then, so the Dock is accepted and the fold holds the new link.
    #[test]
    fn a_same_pass_unlink_frees_the_belt_end_for_a_later_dock() {
        let (_dir, mut host) = test_host();
        let (_ingress_tx, mut ingress_rx, cmd_tx, mut results_rx) = channels();
        let (a, d, e) = review_board(&mut host, &mut ingress_rx, &mut results_rx, &cmd_tx);
        let ids = [a, d, e];
        let resolve = move |h: u64| ids.get(h as usize).copied();
        apply_gesture(
            &mut host,
            GridCommand::Dock { belt: 1, endpoint: fabrico_protocol::BeltEnd::Tail, node: 0, port: 1 },
            resolve,
        )
        .expect("D joins A's end");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("fold the join");
        assert_eq!(host.core().state.link_target((a, 0)), Some((d, 0)), "MEASURED: A feeds D");

        apply_gesture(
            &mut host,
            GridCommand::Unlink { belt: 1, endpoint: fabrico_protocol::BeltEnd::Tail, node: 0, port: 1 },
            resolve,
        )
        .expect("unlink D from A's end");
        apply_gesture(
            &mut host,
            GridCommand::Dock { belt: 2, endpoint: fabrico_protocol::BeltEnd::Tail, node: 0, port: 1 },
            resolve,
        )
        .expect("E joins the end the same pass freed");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("fold the pass");
        assert_eq!(host.core().state.link_target((a, 0)), Some((e, 0)), "A's end now feeds E");
    }

    /// CONTROL (the key match): a pending Dock on one Out of a machine leaves its other Out
    /// free in the same pass.
    #[test]
    fn a_same_pass_dock_on_one_out_leaves_the_other_out_free() {
        let (_dir, mut host) = test_host();
        let (_ingress_tx, mut ingress_rx, cmd_tx, mut results_rx) = channels();
        let f = three_output_factory(&mut host, 0, &mut ingress_rx, &mut results_rx, &cmd_tx);
        let outs = mechanical_outs(&host, f);
        assert!(outs.len() >= 2, "MEASURED: the Factory has two mechanical Outs ({outs:?})");
        let (d1, s1) = out_doorstep(&host, f, outs[0]);
        let (d2, s2) = out_doorstep(&host, f, outs[1]);
        let p = folded_belt(&mut host, &[d1, (d1.0 + s1.0, d1.1 + s1.1)], &mut ingress_rx, &mut results_rx, &cmd_tx);
        let q = folded_belt(&mut host, &[d2, (d2.0 + s2.0, d2.1 + s2.1)], &mut ingress_rx, &mut results_rx, &cmd_tx);
        let ids = [f, p, q];
        let resolve = move |h: u64| ids.get(h as usize).copied();
        let port = |i: usize| u16::try_from(i).expect("fits");

        apply_gesture(
            &mut host,
            GridCommand::Dock { belt: 1, endpoint: fabrico_protocol::BeltEnd::Tail, node: 0, port: port(outs[0]) },
            resolve,
        )
        .expect("P docks on the first Out");
        apply_gesture(
            &mut host,
            GridCommand::Dock { belt: 2, endpoint: fabrico_protocol::BeltEnd::Tail, node: 0, port: port(outs[1]) },
            resolve,
        )
        .expect("Q docks on the second Out in the same pass: a different Out is free");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("fold the pass");
        assert_eq!(host.core().state.link_target((f, 0)), Some((p, 0)), "Out key 0 feeds P");
        assert_eq!(host.core().state.link_target((f, 1)), Some((q, 0)), "Out key 1 feeds Q");
    }

    /// CONTROL (the node match): a pending Dock on one machine's Out leaves another machine's
    /// Out under the same key free in the same pass.
    #[test]
    fn a_same_pass_dock_on_one_machine_leaves_another_machine_free() {
        let (_dir, mut host) = test_host();
        let (_ingress_tx, mut ingress_rx, cmd_tx, mut results_rx) = channels();
        let mut machines = Vec::new();
        for x in [20, 30] {
            apply_gesture(&mut host, GridCommand::Place { kind: machine_kind::FACTORY, cell_x: x, cell_y: 20 }, none_resolve)
                .expect("place a factory");
            host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("fold the place");
            machines.push(host.core().state.occupied((x, 20)).expect("the factory"));
        }
        let (m1, m2) = (machines[0], machines[1]);
        let out1 = mechanical_outs(&host, m1)[0];
        let out2 = mechanical_outs(&host, m2)[0];
        let (d1, s1) = out_doorstep(&host, m1, out1);
        let (d2, s2) = out_doorstep(&host, m2, out2);
        let p = folded_belt(&mut host, &[d1, (d1.0 + s1.0, d1.1 + s1.1)], &mut ingress_rx, &mut results_rx, &cmd_tx);
        let q = folded_belt(&mut host, &[d2, (d2.0 + s2.0, d2.1 + s2.1)], &mut ingress_rx, &mut results_rx, &cmd_tx);
        let ids = [m1, m2, p, q];
        let resolve = move |h: u64| ids.get(h as usize).copied();
        let port = |i: usize| u16::try_from(i).expect("fits");

        apply_gesture(
            &mut host,
            GridCommand::Dock { belt: 2, endpoint: fabrico_protocol::BeltEnd::Tail, node: 0, port: port(out1) },
            resolve,
        )
        .expect("P docks on the first machine's Out");
        apply_gesture(
            &mut host,
            GridCommand::Dock { belt: 3, endpoint: fabrico_protocol::BeltEnd::Tail, node: 1, port: port(out2) },
            resolve,
        )
        .expect("Q docks on the second machine's Out in the same pass: a different machine is free");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx).expect("fold the pass");
        assert_eq!(host.core().state.link_target((m1, 0)), Some((p, 0)), "the first machine feeds P");
        assert_eq!(host.core().state.link_target((m2, 0)), Some((q, 0)), "the second machine feeds Q");
    }

    #[test]
    fn same_tick_rotate_then_overlapping_place_rejected_and_restores() {
        // CR-01 (the BLOCKER): a same-tick `Rotate A` + `Place B` where B targets a cell
        // A's NEW orientation claims must REJECT B — otherwise the EDITS-FIRST fold
        // (Rotate A claims the cell for A, then Place B's CLAIM-never-EVICT overwrites it
        // for B) produces a `Core` whose `occupancy` disagrees with its expanded
        // footprints, so `restore(snapshot(core))` fails its own `validate_invariants`
        // (`CellCollision`) and crash-recovery / save-load loses the grid. The host
        // `occupied_by` must replay the pending `Rotate` (free old body + claim new body)
        // so B's validation sees the post-fold geometry. This test is the proof the gap
        // is closed at the host level (it was previously uncovered).
        use fabrico_core::snapshot::{restore, snapshot};
        let (_dir, mut host) = test_host();
        let (_ingress_tx, mut ingress_rx, cmd_tx, mut results_rx) = channels();
        let no_handles = |_h: u64| None;

        // Place a 2×3 ROUTER A at (10,10): rot0 covers x∈{10,11}, y∈{10,11,12}.
        apply_gesture(
            &mut host,
            GridCommand::Place {
                kind: machine_kind::ROUTER,
                cell_x: 10,
                cell_y: 10,
            },
            no_handles,
        )
        .expect("place router A");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("tick folds the place");
        let a = host.core().last_tick.placed[0];
        let resolve = move |h: u64| (h == 0).then_some(a);

        // SAME tick: Rotate A one quarter-turn CW → rot1 covers x∈{10,11,12}, y∈{10,11};
        // it newly CLAIMS (12,10) and (12,11). Accepted (all new cells are free / its own).
        apply_gesture(&mut host, GridCommand::Rotate { node: 0, ccw: false }, resolve)
            .expect("rotate A is accepted (its new orientation is collision-free)");

        // SAME tick: Place a 1×1 SOURCE B at (12,10) — a cell A's PENDING rotate claims.
        // Without the pending-Rotate reconciliation this validates against the stale
        // (pre-rotate) occupancy and is wrongly accepted, desyncing the fold. With the
        // fix, occupied_by((12,10)) replays the pending Rotate A and reports it owned.
        assert_eq!(
            apply_gesture(
                &mut host,
                GridCommand::Place {
                    kind: machine_kind::SOURCE,
                    cell_x: 12,
                    cell_y: 10,
                },
                resolve,
            ),
            Err(CommandError::FootprintCollision),
            "a Place onto a cell a same-tick pending Rotate claims is rejected (CR-01)"
        );
        assert_eq!(
            host.pending_edits().len(),
            1,
            "only the accepted Rotate enqueued an edit (the Place reject enqueued nothing)"
        );

        // Fold the tick (only Rotate A folds) and prove the Core round-trips its own
        // snapshot — the equality oracle that the desync would have broken.
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("tick folds the rotate");
        assert!(
            host.core().state.occupied((12, 10)) == Some(a),
            "A's rotated body owns (12,10) after the fold"
        );
        restore(&snapshot(host.core()))
            .expect("the post-fold Core round-trips snapshot→restore (no CellCollision)");
    }

    #[test]
    fn same_tick_two_rotates_reconcile_freed_cell_and_restore() {
        // CR-01 (the two-Rotate facet): the pending-Rotate reconciliation must account
        // for the cells a pending Rotate FREES as well as those it claims. Here B vacates
        // a cell (by rotating) that A's rotation then legitimately claims in the SAME
        // tick. Without replaying the pending Rotate B, A's validation sees B's STALE
        // pre-rotate body still occupying that cell and FALSELY rejects A; with the fix it
        // sees the freed cell and accepts — and the EDITS-FIRST fold stays consistent, so
        // the Core round-trips.
        //
        // NOTE on geometry: with the 2×3 ROUTER as the only multi-cell catalog machine,
        // two Rotates can NEVER double-claim a mutually-free cell — a node never vacates
        // its anchor (min-corner) cell, and a rotation's only newly-gained cells sit in a
        // column no NON-overlapping neighbour can reach in its own new body. So the
        // meaningful two-Rotate host coverage is this free→reclaim reconciliation (the
        // claim-side reject is covered by the Rotate+Place test above).
        use fabrico_core::snapshot::{restore, snapshot};
        let (_dir, mut host) = test_host();
        let (_ingress_tx, mut ingress_rx, cmd_tx, mut results_rx) = channels();
        let no_handles = |_h: u64| None;

        // A: 2×3 ROUTER at (0,2) — rot0 covers x∈{0,1}, y∈{2,3,4}.
        apply_gesture(
            &mut host,
            GridCommand::Place {
                kind: machine_kind::ROUTER,
                cell_x: 0,
                cell_y: 2,
            },
            no_handles,
        )
        .expect("place router A");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("tick folds A");
        let a = host.core().last_tick.placed[0];

        // B: 2×3 ROUTER at (2,0) — rot0 covers x∈{2,3}, y∈{0,1,2} (disjoint from A).
        apply_gesture(
            &mut host,
            GridCommand::Place {
                kind: machine_kind::ROUTER,
                cell_x: 2,
                cell_y: 0,
            },
            no_handles,
        )
        .expect("place router B");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("tick folds B");
        let b = host.core().last_tick.placed[0];
        let resolve = move |h: u64| match h {
            0 => Some(a),
            1 => Some(b),
            _ => None,
        };

        // SAME tick: Rotate B CW first → rot1 covers x∈{2,3,4}, y∈{0,1}; it FREES (2,2).
        apply_gesture(&mut host, GridCommand::Rotate { node: 1, ccw: false }, resolve)
            .expect("rotate B is accepted");
        // Then Rotate A CW → rot1 covers x∈{0,1,2}, y∈{2,3}; it CLAIMS (2,2). This is only
        // legal because the pending Rotate B already vacated (2,2) THIS tick.
        apply_gesture(&mut host, GridCommand::Rotate { node: 0, ccw: false }, resolve)
            .expect("rotate A is accepted (pending Rotate B freed (2,2) — no false reject)");
        assert_eq!(
            host.pending_edits().len(),
            2,
            "both rotates enqueued an edit (neither falsely rejected)"
        );

        // Fold both rotates EDITS-FIRST and prove the Core round-trips: A owns the cell B
        // freed, with no double-claim.
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("tick folds both rotates");
        assert_eq!(
            host.core().state.occupied((2, 2)),
            Some(a),
            "A's rotated body owns (2,2) after both rotates fold"
        );
        restore(&snapshot(host.core()))
            .expect("the post-fold Core round-trips snapshot→restore (no CellCollision)");
    }

    #[test]
    fn same_tick_delete_then_rotate_then_place_accepts_and_restores() {
        // WR-01 #1 (Delete-then-Rotate phantom claim): a same-tick `Delete A` followed
        // by `Rotate A` then a `Place B` onto a cell A's NEW orientation WOULD have
        // claimed. Pre-fix, the host adapter's `cell_of`/`footprint_of` and the
        // `occupied_by` Rotate branch read `core.state` BLIND to the earlier pending
        // Delete: the Rotate enqueued and `occupied_by` phantom-claimed A's would-be
        // rotated body, FALSELY rejecting B even though the EDITS-FIRST fold (Delete A
        // first, then `rotate_footprint` no-ops on the now-cell-less A) leaves those
        // cells FREE. With the effective-state reconciliation, `cell_of(A)` reads absent
        // once the Delete is pending, so the Rotate is rejected as `UnknownNode` (a
        // deleted node cannot be rotated — exactly what the headless `GridSession` does),
        // and B is ACCEPTED onto the genuinely-free cell. The Core then round-trips its
        // own snapshot gate — the equality oracle a divergence would have broken.
        use fabrico_core::snapshot::{restore, snapshot};
        let (_dir, mut host) = test_host();
        let (_ingress_tx, mut ingress_rx, cmd_tx, mut results_rx) = channels();
        let no_handles = |_h: u64| None;

        // Place a 2×3 ROUTER A at (10,10): rot0 covers x∈{10,11}, y∈{10,11,12}. Its
        // rot1 (3×2) WOULD cover x∈{10,11,12}, y∈{10,11} — newly claiming (12,10).
        apply_gesture(
            &mut host,
            GridCommand::Place {
                kind: machine_kind::ROUTER,
                cell_x: 10,
                cell_y: 10,
            },
            no_handles,
        )
        .expect("place router A");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("tick folds the place");
        let a = host.core().last_tick.placed[0];
        let resolve = move |h: u64| (h == 0).then_some(a);

        // SAME tick: Delete A — enqueued (the fold will remove A's body).
        apply_gesture(&mut host, GridCommand::Delete { node: 0 }, resolve)
            .expect("delete A is accepted");

        // SAME tick: Rotate A — a node a prior pending Delete removed is no longer
        // rotatable. The effective `cell_of(A)` reads absent, so validation rejects it
        // as `UnknownNode` (matching the headless re-fold) and it enqueues NOTHING; the
        // pre-fix bug enqueued it and phantom-claimed A's rotated body.
        assert_eq!(
            apply_gesture(&mut host, GridCommand::Rotate { node: 0, ccw: false }, resolve),
            Err(CommandError::UnknownNode),
            "rotating a same-tick pending-deleted node is rejected (no phantom claim)"
        );

        // SAME tick: Place a 1×1 SOURCE B at (12,10) — the cell A's would-be rotation
        // claims. The fold leaves it FREE (A is deleted, the rotate no-ops), so B must be
        // ACCEPTED. Pre-fix this was falsely rejected as a phantom collision.
        apply_gesture(
            &mut host,
            GridCommand::Place {
                kind: machine_kind::SOURCE,
                cell_x: 12,
                cell_y: 10,
            },
            resolve,
        )
        .expect("place B onto the genuinely-free cell is accepted (no phantom Rotate claim)");

        // Only the Delete + the Place enqueued (the Rotate reject enqueued nothing).
        assert_eq!(
            host.pending_edits().len(),
            2,
            "exactly the Delete A and the Place B enqueued (Rotate A rejected)"
        );

        // Fold the tick (Delete A frees A's body, Place B claims (12,10)) and prove the
        // Core round-trips its own snapshot — no phantom occupancy desync.
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("tick folds the delete + place");
        assert_eq!(
            host.core().state.cell_of(a),
            None,
            "A is gone after its same-tick Delete folds"
        );
        assert!(
            host.core().state.occupied((12, 10)).is_some(),
            "B owns (12,10) after the fold — the cell the phantom claim would have stolen"
        );
        restore(&snapshot(host.core()))
            .expect("the post-fold Core round-trips snapshot→restore (no CellCollision)");
    }

    #[test]
    fn same_tick_two_rotates_same_node_apply_both_quarter_turns() {
        // WR-01 #2 (double-Rotate dropped turn): two same-tick `Rotate A` gestures on the
        // SAME node must apply BOTH quarter-turns (rot0 → rot1 → rot2). Pre-fix, the
        // second `validate_normalize` read `footprint_of(A)` BLIND to the first pending
        // Rotate (still rot0), so it re-derived `new_rot = 1` and enqueued a record
        // IDENTICAL to the first — the fold applied rot0→rot1 TWICE and the user's second
        // quarter-turn was silently DROPPED (final rot stuck at 1). With `footprint_of`
        // presenting the post-first-rotate orientation, the second gesture sees rot1,
        // resolves `new_rot = 2`, and BOTH turns land — final rot == 2.
        use fabrico_core::snapshot::{restore, snapshot};
        let (_dir, mut host) = test_host();
        let (_ingress_tx, mut ingress_rx, cmd_tx, mut results_rx) = channels();
        let no_handles = |_h: u64| None;

        // A: 2×3 ROUTER at (50,50), isolated (every rotation is collision-free).
        apply_gesture(
            &mut host,
            GridCommand::Place {
                kind: machine_kind::ROUTER,
                cell_x: 50,
                cell_y: 50,
            },
            no_handles,
        )
        .expect("place router A");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("tick folds the place");
        let a = host.core().last_tick.placed[0];
        let resolve = move |h: u64| (h == 0).then_some(a);

        // SAME tick: Rotate A CW (rot0 → rot1) then Rotate A CW again. The SECOND must
        // resolve to rot2 off the first pending Rotate's effective orientation — not a
        // duplicate rot1.
        apply_gesture(&mut host, GridCommand::Rotate { node: 0, ccw: false }, resolve)
            .expect("first rotate A is accepted (rot0 → rot1)");
        let rec1 = host.pending_edits().last().expect("first rotate enqueued").op.clone();
        assert!(
            matches!(rec1, EditOp::Rotate { new_rot: 1, old_rot: 0, .. }),
            "the first quarter-turn resolves rot0 → rot1"
        );

        apply_gesture(&mut host, GridCommand::Rotate { node: 0, ccw: false }, resolve)
            .expect("second rotate A is accepted (rot1 → rot2)");
        let rec2 = host.pending_edits().last().expect("second rotate enqueued").op.clone();
        assert!(
            matches!(rec2, EditOp::Rotate { new_rot: 2, old_rot: 1, .. }),
            "the second quarter-turn resolves rot1 → rot2 (NOT a dropped duplicate rot1)"
        );
        assert_eq!(
            host.pending_edits().len(),
            2,
            "both rotates enqueued distinct records (no dropped turn)"
        );

        // Fold both EDITS-FIRST: rot0 → rot1 → rot2. The final orientation is rot2 — proof
        // the second quarter-turn was NOT dropped — and the Core round-trips its snapshot.
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("tick folds both rotates");
        assert_eq!(
            host.core().state.footprint_of(a).map(|f| f.rot),
            Some(2),
            "A's final orientation is rot2 — both quarter-turns applied"
        );
        restore(&snapshot(host.core()))
            .expect("the post-fold Core round-trips snapshot→restore (no CellCollision)");
    }

    // ----- Phase 19-02: live Undo/Redo routing (the CommandError::Malformed blocker) -----

    #[test]
    fn empty_stack_undo_redo_is_typed_error_and_enqueues_nothing() {
        // Routing before validate_normalize means Undo/Redo NEVER hit the Malformed
        // arm — on an empty stack they return the typed NothingToUndo/NothingToRedo
        // from resolve_*, and apply_gesture PROPAGATES the Err having enqueued nothing
        // (no mutation on reject — SC#2).
        let (_dir, mut host) = test_host();
        let no_handles = |_h: u64| None;

        assert_eq!(
            apply_gesture(&mut host, GridCommand::Undo, no_handles),
            Err(CommandError::NothingToUndo),
            "undo on genesis is a typed NothingToUndo (never Malformed)"
        );
        assert_eq!(
            apply_gesture(&mut host, GridCommand::Redo, no_handles),
            Err(CommandError::NothingToRedo),
            "redo on genesis is a typed NothingToRedo (never Malformed)"
        );
        assert_eq!(
            host.pending_edits().len(),
            0,
            "a rejected empty-stack undo/redo enqueues nothing"
        );
    }

    #[test]
    fn normal_gestures_get_distinct_action_ids() {
        // Each normal gesture rides enqueue_edit_with_new_action -> one action per
        // gesture (its own undo step). Two same-tick Places enqueue records under
        // DISTINCT contiguous action ids (Pitfall 1: not all action 0).
        let (_dir, mut host) = test_host();
        let no_handles = |_h: u64| None;

        apply_gesture(
            &mut host,
            GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 1, cell_y: 1 },
            no_handles,
        )
        .expect("first place accepted");
        apply_gesture(
            &mut host,
            GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 2, cell_y: 1 },
            no_handles,
        )
        .expect("second place accepted");

        let pending = host.pending_edits();
        assert_eq!(pending.len(), 2, "both places enqueued");
        assert_ne!(
            pending[0].action, pending[1].action,
            "each normal gesture gets its OWN action id (not both 0)"
        );
        assert_eq!(
            pending[1].action,
            pending[0].action + 1,
            "action ids are monotonic contiguous"
        );
    }

    #[test]
    fn live_undo_redo_routes_coalesces_and_signals_keyframe() {
        // The end-to-end blocker proof: a live Undo after a Place is ACCEPTED (never
        // Malformed), folds EDITS-FIRST as a coalesced group under one action, removes
        // the node, sets took_undo_redo_this_tick(), and flips availability; a Redo
        // re-mints it.
        let (_dir, mut host) = test_host();
        let (_ingress_tx, mut ingress_rx, cmd_tx, mut results_rx) = channels();
        let no_handles = |_h: u64| None;

        // Place a node and fold it (one normal action).
        let nodes_before = host.core().state.node_ids().count();
        apply_gesture(
            &mut host,
            GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 3, cell_y: 3 },
            no_handles,
        )
        .expect("place accepted");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("fold the place");
        assert_eq!(host.core().state.node_ids().count(), nodes_before + 1, "node minted");
        assert!(!host.took_undo_redo_this_tick(), "a normal fold is not an undo/redo tick");
        assert!(host.can_undo(), "the placement is undoable");
        assert!(!host.can_redo(), "nothing to redo yet");

        // Live Undo: routed to resolve_undo, enqueued as one action group, folded.
        apply_gesture(&mut host, GridCommand::Undo, no_handles)
            .expect("live undo is ACCEPTED (never CommandError::Malformed)");
        // The whole compensating group shares ONE action id.
        let group = host.pending_edits();
        assert!(!group.is_empty(), "undo enqueued a compensating group");
        let group_action = group[0].action;
        assert!(
            group.iter().all(|e| e.action == group_action),
            "the undo group folds under ONE shared action id (single undo step)"
        );
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("fold the undo group");
        assert_eq!(
            host.core().state.node_ids().count(),
            nodes_before,
            "the undo removed the placed node (EDITS-FIRST fold of the inverse Delete)"
        );
        assert!(
            host.took_undo_redo_this_tick(),
            "the folded batch carried an Undo marker (Plan 03 keyframe trigger)"
        );
        assert!(host.can_redo(), "the undone action is now redoable");

        // Live Redo re-mints the node and re-signals the keyframe.
        apply_gesture(&mut host, GridCommand::Redo, no_handles)
            .expect("live redo is ACCEPTED (never Malformed)");
        host.tick_once(&mut ingress_rx, &mut results_rx, &cmd_tx)
            .expect("fold the redo group");
        assert_eq!(
            host.core().state.node_ids().count(),
            nodes_before + 1,
            "the redo re-applied the placement"
        );
        assert!(host.took_undo_redo_this_tick(), "the folded batch carried a Redo marker");

        // The persisted edit-log carries the Undo + Redo lineage markers.
        let edits = host.logged_edits().expect("read edit-log");
        assert!(
            edits.iter().any(|e| matches!(e.op, EditOp::Undo { .. })),
            "an Undo lineage marker was logged"
        );
        assert!(
            edits.iter().any(|e| matches!(e.op, EditOp::Redo { .. })),
            "a Redo lineage marker was logged"
        );
    }
    /// Phase 91 review WR-A-04: the host's duplicate-path read compares by the key the host
    /// routes on, so a forged slashless `route-1` (a hand-edited save; `fold_configure`
    /// applies records as written) owns `/route-1`.
    ///
    /// RED BEFORE THE FIX: the read compared raw strings and answered `None`.
    #[test]
    fn the_host_path_owner_read_compares_route_keys() {
        use fabrico_core::edit::{EDIT_SCHEMA_VERSION, EditRecord, MachineConfig as CoreConfig};
        let mut core = Core::genesis(LogHeader { schema_version: SCHEMA_VERSION, seed: 7 });
        let record = |sequence: u64, op: EditOp| EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence,
            tick: 0,
            action: sequence,
            op,
        };
        core.advance_edits(
            &[record(
                1,
                EditOp::Place { kind: machine_kind::ENDPOINT, cell_x: 0, cell_y: 0, w: 1, h: 1, ports: Vec::new(), rot: 0 },
            )],
            &[],
        );
        let forged = core.last_tick.placed[0];
        core.advance_edits(
            &[record(
                2,
                EditOp::Configure {
                    node: forged,
                    config: CoreConfig::Endpoint { path: "route-1".to_owned() },
                    code_hash: [0u8; 32],
                },
            )],
            &[],
        );
        let adapter = HostGridLookup::new(&core, &[], |_| None);
        assert_eq!(
            (
                adapter.endpoint_path_owner("/route-1", NodeId::null()),
                adapter.endpoint_path_owner("/route-1", forged),
            ),
            (Some(forged), None),
            "route-1 answers at /route-1, and a Route never owns against itself"
        );
    }
}
