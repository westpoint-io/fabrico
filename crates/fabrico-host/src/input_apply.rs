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

use fabrico_command::{
    CommandError, GridLookup, is_handler_shape, is_route_shape, validate_normalize,
};
use fabrico_core::core::Core;
use fabrico_core::edit::{EditOp, EditRecord, MachineConfig};
use fabrico_core::ids::NodeId;
use std::collections::{BTreeMap, BTreeSet};

use fabrico_core::state::{
    BeltTile, Footprint, MAX_FOOTPRINT_DIM, Node, Port, add_port_geometry, base_footprint,
    cells_of_footprint, remove_port_geometry,
};
use fabrico_protocol::{GridCommand, machine_kind};
use slotmap::Key;

use crate::driver::Host;
use crate::sim_loop::{BeltRunPace, GestureFrame, MAX_RUN_PACE_BELTS};

/// Map a live [`Node`] variant plus its declared `ports` to its shared `machine_kind`
/// byte (the single source of truth is [`fabrico_protocol::machine_kind`]). Total over
/// every variant. Mirrors `fabrico_command::grid_view`'s `kind_byte`, the Delete-time
/// kind capture.
///
/// # The FACTORY/HANDLER arm calls the SHARED predicate (72-06, D-26)
/// A Handler is a [`Node::Factory`] (D-11 adds no `Node` variant), so this function
/// cannot emit `HANDLER` without reading `GridState.ports`, hence the second argument.
/// The rule is NOT restated here. It is
/// [`fabrico_command::is_handler_shape`](fabrico_command::is_handler_shape), which
/// `grid_view::kind_byte` and `render_packet::machine_kind_of` also call. That matters
/// more here than anywhere: `grid_view`'s copy is the Delete-time kind CAPTURE and
/// `command.rs`'s inverse target-identity guard compares against it, so if these three
/// mappings could disagree an undo would delete the wrong node.
///
/// # It is stricter than the servicing predicate, deliberately
/// `fabrico_core::admit::inbox_class` answers "is this delivery a wire request" from
/// port 0's medium ALONE (D-16). This answers "what is this machine called" and ALSO
/// demands an electrical Out. THE NAMING RULE IS THE STRICTER OF THE TWO, because a
/// machine named Handler that has no way to send an answer back is the overstating-label
/// defect SERVE-03 exists to close. The two must never be merged (R-6).
#[must_use]
fn kind_byte(node: &Node, ports: Option<&[Port]>) -> u8 {
    match node {
        Node::Source(_) => machine_kind::SOURCE,
        Node::Belt(_) => machine_kind::BELT,
        Node::Tee(_) => machine_kind::TEE,
        Node::Balancer(_) => machine_kind::BALANCER,
        Node::Merge(_) => machine_kind::MERGE,
        Node::Router(_) => machine_kind::ROUTER,
        // FACTORY or HANDLER, decided by the SHARED predicate and by nothing local.
        Node::Factory(_) => {
            if fabrico_command::is_handler_shape(node, ports) {
                machine_kind::HANDLER
            } else {
                machine_kind::FACTORY
            }
        }
        Node::Sink(_) => machine_kind::SINK,
        // Explicit map (never `as u8`): the machine_kind byte order is distinct from
        // the Node discriminant order, so this Node::X => machine_kind::Y arm is the
        // only bridge. WIRE is a LIVE byte since 63-03 — the DrawWire undo inverse
        // emits `Delete { kind: machine_kind::WIRE }` and the target-identity guard
        // compares against it — so a wrong arm here is now a wrong deletion, not a
        // dormant mapping. ENDPOINT is not yet produced by any command.
        Node::Wire(_) => machine_kind::WIRE,
        Node::Endpoint(_) => machine_kind::ENDPOINT,
        // Phase 76 (SHAPE-10): a Label is Node discriminant 10 and kind byte 11.
        Node::Label(_) => machine_kind::LABEL,
    }
}

/// The host's read-only [`GridLookup`] adapter — the live-producer half of the
/// "one validation path, two producers" seam (CMD-01). It views grid occupancy +
/// cells through core [`GridState`](fabrico_core::state::GridState) (the single
/// SPAT-01 authority), resolves dense handles through the caller's `resolve` closure,
/// and reads node kinds straight off the [`Core`] — the IDENTICAL surface the
/// headless [`GridViewLookup`](fabrico_command::GridViewLookup) exposes, so
/// [`validate_normalize`] validates a live gesture exactly as it validates a headless
/// command. Every method is read-only and non-panicking (`resolve`/node lookups yield
/// `None`, never an index panic — T-8-GESTURE-PANIC).
///
/// # Every pending-record replay in this file (plan 76-07 audit)
/// Read from `grep -rn pending_edits crates/fabrico-host/src` at plan 76-07, CR-02's
/// last ask. For each site: does it read cell geometry or occupancy, and does it see a
/// pending `Configure{Label}`?
///
/// RECORDS THAT MOVE CELLS. `Place` and `DrawBelt` claim (the reserved null key, no id
/// yet); `Delete` frees; `Rotate`, `AddPort`, `RemovePort` and, since phase 76,
/// `Configure{Label}` free the body the node had before the record and claim the body it
/// has after. Every other record (`Dock`, `Unlink`, `DrawWire`, every other `Configure`,
/// the `Undo` and `Redo` markers) moves no cell.
///
/// SITES THAT READ CELLS, all through ONE replay, `effective_geometry_upto`:
/// - `effective_geometry_upto`: the replay (Delete, Rotate, AddPort, RemovePort and
///   `Configure{Label}`, the last since 76-07, with the fold's live-label guard and clamp).
/// - `effective_body_upto`: the same replay without the port list.
/// - `occupied_by`: core occupancy, then every cell-moving record in order; the Rotate arm
///   and the free-then-claim arm (AddPort, `Configure{Label}`, RemovePort) read
///   `effective_body_upto` before and after the record. Sees a label resize since 76-07.
/// - `footprint_of`: `effective_body_upto` over the whole buffer, so it reads the same box
///   `occupied_by` claims. Sees a label resize since 76-07.
/// - `cell_of`: absent after a pending Delete (`pending_deleted`); the replay's anchor when
///   a port edit is pending. A label resize keeps the anchor, so `core.state` is right.
/// - `HostGridLookup::new`: builds `pending_ports` and `pending_rekeys`, through the replay,
///   for nodes a pending AddPort or RemovePort names. A label is never one of them.
///
/// SITES THAT REPLAY ONLY PORTS, LINKS OR WIRES. A label cannot reach them: it holds no
/// ports, docks no belt and draws no wire (D-07), so no record they read names a label.
/// - `rekeys_of` and `key_before`: the re-key each pending AddPort or RemovePort implies.
/// - `ports_of`, `kind_of` and `is_handler`: the `pending_ports` list.
/// - `link_exists`, `wire_from_port` and `wire_touches_port`: pending Dock, Unlink,
///   DrawWire and Delete, post-pass keys mapped back through `key_before`.
/// - `pending_deleted`: a pending Delete makes a node absent; every per-node answer and
///   `belt_geometry` read it.
/// - `endpoint_path_owner`, `links_touching` and `fold_belt_at`: the board the fold will see
///   (`board_after_pending`), so a pending Place's minted `/route-N`, a pending rename and a
///   pending Delete all count (phase 91 review CR-A-01).
///
/// SITES OUTSIDE THE ADAPTER.
/// - `apply_gesture` block (1): builds this adapter for `validate_normalize`, so every
///   gesture sees a pending `Configure{Label}` through the reads above.
/// - `apply_gesture`'s Delete capture (1a, plan 86-05): reads `capture_deleted_subgraph`
///   on ONE board, the core's own fold of the earlier records (a scratch clone advanced
///   by `advance_edits`), not this replay and not the pre-pass core; `host.core()` itself
///   only when nothing comes before the Delete. A label resized earlier in the same pass
///   is captured at its replayed box that way, as is every other kind's box, turn, ports
///   and cascade (`probe_p1`, `probe_p3`, `probe_c1` to `probe_c7`, `probe_d1`, `probe_d2`).
///   The same board refuses a Delete of a node an earlier record already took with its
///   machine (`UnknownNode`, `probe_c8`, `probe_c9`), the case `pending_deleted` cannot see.
/// - `apply_gesture`'s Undo and Redo arms: enqueue `compute_inverse`'s group with no
///   adapter and no validation. `SimLoop::acquire_input` applies them only on an empty
///   buffer, so they read no pending record, but nothing checks the cells the group
///   claims either (the turned-machine Delete then Undo path plan 76-12 measures).
/// - `apply_run_pace`: builds the same adapter but asks only `resolve` and `kind_of`. The
///   `Configure{Belt}` it validates reads no cell, so a pending label grow cannot change
///   its verdict, and its own pending `Configure{Belt}` stays in `occupied_by`'s no-op
///   arm, so it cannot change a label's.
/// - `sim_loop.rs`: `acquire_input` (twice, the held Undo or Redo) and `tick_body` (the
///   Timer re-projection guard) ask `is_empty()` only and read no record.
/// - `driver.rs`: the `Host` field, `Host::new`, `enqueue_edit`, the `pending_edits`
///   accessor and `tick_once`'s `take` are the buffer itself and the fold that drains
///   it; `tick_once` folds `Configure{Label}` through `fold_configure`, the truth this
///   replay mirrors.
///
/// COPIES OUTSIDE THE HOST THAT DO NOT SEE QUEUED RECORDS. The frontend keeps its own
/// occupancy prediction: the label panel's outline (`paintLabelResize` with
/// `footprintFits`, `frontend/src/chrome/App.tsx`) and the Place ghost (`footprintFits`
/// in `frontend/src/input/ghost.ts`, driven from `gestures.ts`) judge the folded scene
/// only. On a paused board a queued Place leaves the outline promising a grow the host
/// then refuses `ResizeCovers`, and a queued grow leaves the ghost promising a cell the
/// host then refuses. No data is lost (the host refuses), but the prediction is false.
/// Known limitation, tracked as an open item (plan 76-12 appends the label case).
///
/// THE RULE FOR THE NEXT RECORD THAT MOVES CELLS. It goes into `effective_geometry_upto`
/// (how the body changes) and into the free-then-claim arm of `occupied_by` (one more
/// alternative, on its own line), and nowhere else, so `footprint_of`, `cell_of` and
/// `occupied_by` agree by construction. It gets an agreement test in the shape of
/// `host_adapter_sees_a_pending_label_resize` and a one-pass leg on `demo_host` in
/// `tests/label_same_pass.rs`, and the two frontend copies above are asked the same
/// question.
struct HostGridLookup<'a, F: Fn(u64) -> Option<NodeId>> {
    /// The deterministic core — the single occupancy/cell authority (`occupied`/
    /// `cell_of`), node-kind capture at Delete time, AND the re-wire guard (an
    /// already-linked output port — WR-04).
    core: &'a Core,
    /// This tick's enqueued-but-not-yet-folded topology edits, in enqueue order
    /// (WR-01). The core occupancy index only reflects PRIOR ticks (this tick's edits
    /// fold EDITS-FIRST inside `tick_once`, AFTER the gesture-drain loop), so
    /// occupancy must ALSO see the cells moved by records already enqueued earlier in
    /// THIS tick (the audit above lists them). Otherwise two same-cell `Place`s in one
    /// tick both validate and stack
    /// (the TOCTOU the headless `GridSession` avoids by re-projecting after each
    /// apply). Sourced from the host's single enqueued-edit buffer (NOT a parallel
    /// sidecar), so `core.state` + this buffer are the only occupancy authorities.
    pending_edits: &'a [EditRecord],
    /// The dense `u64` render handle → live `NodeId` resolver (the inverse of the
    /// render builder's handle table; an unknown handle yields `None`).
    resolve: F,
    /// The port list of every node a PENDING `AddPort` or `RemovePort` names, after
    /// replaying this tick's pending edits through the fold's own geometry (plan 74.1-23,
    /// review WR-01). Owned here because [`GridLookup::ports_of`] answers a borrowed
    /// slice; built once, at construction, by [`HostGridLookup::new`]. A node with no
    /// pending port edit is absent and reads `core.state` as before.
    ///
    /// THE OCCUPANCY HALF READS THE SAME NUMBERS (plan 74.1-32, review round 4 IN-01). The
    /// port INDICES this list answers are post-edit numbering, and so are the indices a
    /// gesture validated now will name. The folded links and wires are still keyed in
    /// PRE-edit numbering until the fold re-keys them, so [`link_exists`], [`wire_from_port`]
    /// and [`wire_touches_port`] map a post-edit key BACK through [`pending_rekeys`] before
    /// reading them. Without that, one pass holding `RemovePort` of an earlier Out and a
    /// `DrawWire` from the index a wired Out moves to found no wire there and minted a second
    /// wire out of one Out. [`kind_of`] and [`is_handler`] read this list too.
    ///
    /// [`link_exists`]: GridLookup::link_exists
    /// [`wire_from_port`]: GridLookup::wire_from_port
    /// [`wire_touches_port`]: GridLookup::wire_touches_port
    /// [`kind_of`]: GridLookup::kind_of
    /// [`is_handler`]: GridLookup::is_handler
    /// [`pending_rekeys`]: Self::pending_rekeys
    pending_ports: BTreeMap<NodeId, Vec<Port>>,
    /// Every pending port edit the fold will APPLY, per node, in enqueue order, with the
    /// re-key it implies (plan 74.1-32, review round 4 IN-01): the same raw-catalog and
    /// Out-key shift rule `fold_remove_port` and `fold_add_port` apply to docks and wire
    /// endpoints, read from those functions. An edit the fold no-ops (a removal past the
    /// list, an edit on a cell-less node) is absent.
    pending_rekeys: BTreeMap<NodeId, Vec<PendingRekey>>,
    /// THE BOARD THE FOLD WILL SEE (phase 89, D-08): a scratch clone of `core` advanced by
    /// every pending record with the core's own fold, built at most once per adapter and only
    /// when [`GridLookup::links_touching`], [`GridLookup::fold_belt_at`] or
    /// [`GridLookup::endpoint_path_owner`] is asked with a non-empty pending buffer (a
    /// Rotate's re-dock read, a Route path's uniqueness read). The same board plan 86-05's Delete capture reads in [`apply_gesture`]
    /// block (1a), for the same reason: a pending Rotate's severances are derived inside the
    /// fold, so no field-by-field replay of the buffer can answer which docks it leaves.
    fold_board: std::cell::OnceCell<Core>,
}

/// One pending port edit's effect on link and wire keys, as `fold_add_port` and
/// `fold_remove_port` apply it (plan 74.1-32). `pos` is the edit's index in the pending
/// buffer.
#[derive(Clone, Copy, Debug)]
struct PendingRekey {
    pos: usize,
    kind: RekeyKind,
}

#[derive(Clone, Copy, Debug)]
enum RekeyKind {
    /// An insert at catalog `catalog` (the record's index clamped to the append position).
    /// `out_key` is the inserted port's Out routing key when it is an Out.
    Add { catalog: u16, out_key: Option<u16> },
    /// A removal at catalog `catalog`. `out_key` is the removed port's Out routing key when
    /// it is an Out; `first_fault` is true when it is the node's first Fault, the port the
    /// `FAULT_PORT` sentinel names.
    Remove { catalog: u16, out_key: Option<u16>, first_fault: bool },
}

/// Which keyspace a link or wire key lives in, which decides how a port edit shifts it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KeySpace {
    /// A raw catalog index: a Head dock's node key and both wire endpoints.
    Catalog,
    /// An Out routing key: a Tail dock's node key (`dock_link_key`), the `from` of a link
    /// out of a machine.
    OutRouting,
}

/// A node's body after replaying pending edits: its anchor, its footprint, and its port
/// list when a pending port edit rewrote it (`None` means "the core's list").
type PendingBody = ((i32, i32), Footprint, Option<Vec<Port>>);

impl<'a, F: Fn(u64) -> Option<NodeId>> HostGridLookup<'a, F> {
    /// Build the adapter over `core` and this tick's `pending_edits`, precomputing the
    /// port list of every node a pending `AddPort` or `RemovePort` names (plan 74.1-23).
    fn new(core: &'a Core, pending_edits: &'a [EditRecord], resolve: F) -> Self {
        let mut adapter = Self {
            core,
            pending_edits,
            resolve,
            pending_ports: BTreeMap::new(),
            pending_rekeys: BTreeMap::new(),
            fold_board: std::cell::OnceCell::new(),
        };
        let edited: BTreeSet<NodeId> = pending_edits
            .iter()
            .filter_map(|e| match e.op {
                EditOp::AddPort { node, .. } | EditOp::RemovePort { node, .. } => Some(node),
                _ => None,
            })
            .collect();
        let mut pending_ports = BTreeMap::new();
        let mut pending_rekeys = BTreeMap::new();
        for node in edited {
            if let Some((_, _, Some(ports))) = adapter.effective_geometry_upto(node, pending_edits.len()) {
                pending_ports.insert(node, ports);
            }
            let rekeys = adapter.rekeys_of(node);
            if !rekeys.is_empty() {
                pending_rekeys.insert(node, rekeys);
            }
        }
        adapter.pending_ports = pending_ports;
        adapter.pending_rekeys = pending_rekeys;
        adapter
    }

    /// The board the pending records leave once folded: `core` itself when nothing is
    /// pending (the fast path, no clone), else the scratch clone [`fold_board`](Self::fold_board)
    /// holds, built on the first ask and its commands and tick discarded.
    fn board_after_pending(&self) -> &Core {
        if self.pending_edits.is_empty() {
            return self.core;
        }
        self.fold_board.get_or_init(|| {
            let mut board = self.core.clone();
            let _discarded = board.advance_edits(self.pending_edits, &[]);
            board
        })
    }

    /// The re-key every pending port edit on `node` implies, in enqueue order, derived from
    /// the port list the fold sees just before each edit (the effective replay up to it) with
    /// the fold's own guards. Mirrors `fold_add_port` (the index clamped to the append
    /// position; an inserted Out's routing key is the count of Outs before it) and
    /// `fold_remove_port` (a removal past the list is a no-op; the removed Out's routing key;
    /// whether it is the first Fault).
    fn rekeys_of(&self, node: NodeId) -> Vec<PendingRekey> {
        use fabrico_core::state::Role;
        let out_key = |list: &[Port], idx: usize| -> u16 {
            u16::try_from(list[..idx].iter().filter(|p| p.role == Role::Out).count()).unwrap_or(u16::MAX)
        };
        let mut out = Vec::new();
        for (pos, e) in self.pending_edits.iter().enumerate() {
            let (is_add, index, port) = match &e.op {
                EditOp::AddPort { node: n, index, port, .. } if *n == node => (true, *index, Some(*port)),
                EditOp::RemovePort { node: n, index, .. } if *n == node => (false, *index, None),
                _ => continue,
            };
            // The node's body as the fold sees it just before this edit. `None`: no cell or
            // deleted earlier in the pass, so the fold no-ops this edit and every later one.
            let Some((_, _, replayed)) = self.effective_geometry_upto(node, pos) else {
                break;
            };
            let list: Vec<Port> = match replayed {
                Some(list) => list,
                None => match self.core.state.ports_of(node) {
                    Some(core_ports) => core_ports.to_vec(),
                    // `fold_add_port` starts a port-less node at an empty list;
                    // `fold_remove_port` no-ops on it.
                    None if is_add => Vec::new(),
                    None => continue,
                },
            };
            let kind = if let Some(port) = port {
                if self.core.state.node(node).is_none() {
                    continue;
                }
                let idx = usize::from(index).min(list.len());
                RekeyKind::Add {
                    catalog: u16::try_from(idx).unwrap_or(u16::MAX),
                    out_key: (port.role == Role::Out).then(|| out_key(&list, idx)),
                }
            } else {
                let idx = usize::from(index);
                if idx >= list.len() {
                    continue;
                }
                let role = list[idx].role;
                RekeyKind::Remove {
                    catalog: index,
                    out_key: (role == Role::Out).then(|| out_key(&list, idx)),
                    first_fault: role == Role::Fault
                        && list.iter().position(|p| p.role == Role::Fault) == Some(idx),
                }
            };
            out.push(PendingRekey { pos, kind });
        }
        out
    }

    /// The key that `key`, named in POST-pass numbering (after every pending edit), had in
    /// the numbering of the state after the pending edits in `[..from_pos]`: the inverse of
    /// the fold's re-key, undone edit by edit from the last. `None` when no earlier key maps
    /// onto it (the port was inserted after `from_pos`, or the fold releases what sat there),
    /// so nothing from that earlier state can be at `key` after the pass.
    ///
    /// The fold's forward rule, for reference: an insert at `k` shifts every key at or above
    /// `k` up one; a removal at `k` releases the key `k` and shifts every key above it down
    /// one; each in its own keyspace (`KeySpace`); the `FAULT_PORT` sentinel never shifts and
    /// is released only by the removal of the first Fault.
    ///
    /// NOT MIRRORED: the fold's FACING verdict (`dock_still_reaches`), which can also release
    /// a belt dock. On a command-built board it releases nothing (no port edit moves a port a
    /// belt touches; `fold_remove_port`'s docblock says why), so it stays the forged-log
    /// defence; where it would release, this answer says "occupied" and the gesture is
    /// refused rather than allowed onto a port the fold frees.
    fn key_before(&self, node: NodeId, key: u16, from_pos: usize, space: KeySpace) -> Option<u16> {
        let Some(edits) = self.pending_rekeys.get(&node) else {
            return Some(key);
        };
        let mut k = key;
        for e in edits.iter().rev().filter(|e| e.pos >= from_pos) {
            if k == fabrico_core::fault::FAULT_PORT {
                if matches!(e.kind, RekeyKind::Remove { first_fault: true, .. }) {
                    return None;
                }
                continue;
            }
            let pivot = match (e.kind, space) {
                (RekeyKind::Add { catalog, .. } | RekeyKind::Remove { catalog, .. }, KeySpace::Catalog) => {
                    Some(catalog)
                }
                (RekeyKind::Add { out_key, .. } | RekeyKind::Remove { out_key, .. }, KeySpace::OutRouting) => {
                    out_key
                }
            };
            let Some(pivot) = pivot else { continue };
            match e.kind {
                // Undo an insert at `pivot`: the inserted port had no earlier key.
                RekeyKind::Add { .. } => match k.cmp(&pivot) {
                    std::cmp::Ordering::Equal => return None,
                    std::cmp::Ordering::Greater => k -= 1,
                    std::cmp::Ordering::Less => {}
                },
                // Undo a removal at `pivot`: every key at or above it sat one higher.
                RekeyKind::Remove { .. } => {
                    if k >= pivot {
                        k = k.saturating_add(1);
                    }
                }
            }
        }
        Some(k)
    }
}

impl<F: Fn(u64) -> Option<NodeId>> HostGridLookup<'_, F> {
    /// True iff a pending `Delete` of `node` appears anywhere in THIS tick's enqueued
    /// edits. The EDITS-FIRST fold will have removed the node by the time this gesture
    /// folds, so every per-node read (`cell_of`/`kind_of`/`ports_of`/`footprint_of`)
    /// MUST present it as ABSENT — the same view the headless `GridSession` gets by
    /// re-folding after every apply (WR-01). A node is never re-minted under the same
    /// id (a pending `Place` mints a fresh id), so a pending `Delete` is terminal.
    ///
    /// It does NOT see a belt or a cable an earlier pending Delete takes with its machine
    /// (the cascade). `apply_gesture`'s capture loop refuses a Delete of such a node from
    /// the scratch board the fold will see (phase 86 review, CR-01).
    fn pending_deleted(&self, node: NodeId) -> bool {
        self.pending_edits
            .iter()
            .any(|e| matches!(e.op, EditOp::Delete { node: n, .. } if n == node))
    }

    /// The EFFECTIVE body of `node` after applying THIS tick's pending edits in
    /// `[..upto]` in enqueue order, the same per-node sequential view the EDITS-FIRST fold
    /// produces. `None` when `node` has no cell in `core.state` (absent / a `Wire`-minted
    /// belt) OR an EARLIER pending `Delete` removed it (terminal: a node is never re-minted
    /// under the same id).
    ///
    /// - A `Rotate` re-stamps its absolute `new_rot` over the fixed anchor, mirroring
    ///   `state::rotate_footprint`.
    /// - An `AddPort` or `RemovePort` (plan 74.1-23, review WR-01) is replayed through the
    ///   fold's OWN geometry, `add_port_geometry` (the base from `base_footprint` of the
    ///   live node) and `remove_port_geometry`, with the fold's own guards (a
    ///   `RemovePort` past the list is a no-op). So a second same-tick add is checked
    ///   against the box the first one grows, at the anchor the first one shifts. Until
    ///   74.1-23 these were no-ops here and the second add was checked against the
    ///   pre-batch box.
    ///
    /// - A `Configure{Label}` (phase 76, plan 76-07, CR-02) re-boxes a live label to its
    ///   `w` by `h` at rot 0 over the fixed anchor, mirroring `fold_configure` and
    ///   `resize_label_box`, clamp included. Until 76-07 every Configure was a no-op here,
    ///   so a Place on a cell a pending grow covers validated against the old box.
    ///
    /// The port list is cloned only once a pending port edit names `node`. The scan is
    /// over the ordered pending `Vec` (never sorted/deduped), so it is deterministic.
    fn effective_geometry_upto(&self, node: NodeId, upto: usize) -> Option<PendingBody> {
        let mut anchor = self.core.state.cell_of(node)?;
        let mut fp = self.core.state.footprint_of(node).unwrap_or(Footprint { w: 1, h: 1, rot: 0 });
        let mut ports: Option<Vec<Port>> = None;
        for e in &self.pending_edits[..upto] {
            match &e.op {
                EditOp::Delete { node: n, .. } if *n == node => return None,
                EditOp::Rotate { node: n, new_rot, .. } if *n == node => fp.rot = *new_rot,
                EditOp::AddPort { node: n, port, index, seat } if *n == node => {
                    let Some(base) = self.core.state.node(node).map(base_footprint) else {
                        continue;
                    };
                    let list = ports.get_or_insert_with(|| {
                        self.core.state.ports_of(node).map(<[Port]>::to_vec).unwrap_or_default()
                    });
                    let g = add_port_geometry(base, anchor, fp, list, *index, *port, *seat);
                    anchor = g.anchor;
                    fp = g.footprint;
                    *list = g.ports;
                }
                EditOp::RemovePort { node: n, index, restore } if *n == node => {
                    if ports.is_none() {
                        // The fold returns early on a node with no port list.
                        let Some(core_ports) = self.core.state.ports_of(node) else {
                            continue;
                        };
                        ports = Some(core_ports.to_vec());
                    }
                    let Some(list) = ports.as_mut() else { continue };
                    if usize::from(*index) >= list.len() {
                        continue;
                    }
                    let g = remove_port_geometry(anchor, fp, list, *index, *restore);
                    anchor = g.anchor;
                    fp = g.footprint;
                    *list = g.ports;
                }
                // Phase 76 (plan 76-07, CR-02): a label resize re-boxes the label exactly as
                // `fold_configure` does through `resize_label_box`: the anchor unchanged, rot
                // 0, `w` by `h`, the port list untouched (a label holds no ports, and an
                // AddPort on one is refused `LabelDoesNotConnect`, so no pending list exists
                // for it). `occupied_by` frees and claims through this replay, so
                // `footprint_of` and `occupied_by` read ONE box.
                //
                // Two mirrors of the fold are kept, so the replay equals the fold for every
                // record, an Undo or Redo group (enqueued without validation) included: the
                // live `Node::Label` guard `fold_configure` applies, and the
                // `1..=MAX_FOOTPRINT_DIM` clamp `resize_label_box` applies. Neither can be
                // reached today because validation already refuses what they catch (a Label
                // config on a non-label is `Malformed`, every box is capped at `LABEL_MAX_W`
                // by `LABEL_MAX_H`), and every prior box an Undo carries came from state the
                // fold already clamped. No test reaches them and no gate counts them as
                // evidence of the fix.
                EditOp::Configure { node: resized, config: MachineConfig::Label { w, h, .. }, .. } if *resized == node => {
                    if matches!(self.core.state.node(node), Some(Node::Label(_))) {
                        let cap = MAX_FOOTPRINT_DIM;
                        fp = Footprint { w: (*w).clamp(1, cap), h: (*h).clamp(1, cap), rot: 0 };
                    }
                }
                _ => {}
            }
        }
        Some((anchor, fp, ports))
    }

    /// The EFFECTIVE `(anchor, w, h, rot)` of `node` after THIS tick's pending edits in
    /// `[..upto]`; see [`effective_geometry_upto`](Self::effective_geometry_upto).
    fn effective_body_upto(
        &self,
        node: NodeId,
        upto: usize,
    ) -> Option<((i32, i32), u16, u16, u8)> {
        self.effective_geometry_upto(node, upto).map(|(anchor, fp, _)| (anchor, fp.w, fp.h, fp.rot))
    }
}

impl<F: Fn(u64) -> Option<NodeId>> GridLookup for HostGridLookup<'_, F> {
    fn occupied_by(&self, cell: (i32, i32)) -> Option<NodeId> {
        // Start from the folded core occupancy index (the single SPAT-01 authority,
        // PRIOR ticks only), then REPLAY this tick's pending edits in ENQUEUE ORDER so
        // the view matches the EDITS-FIRST fold result `tick_once` will produce. The
        // pending buffer is an ordered `Vec` and we never sort/dedup it, so this scan
        // is deterministic.
        //
        // Every gesture this tick folds EDITS-FIRST, AFTER this gesture-drain loop, so
        // core.state cannot see them yet. Reconciling ALL pending ops — not just
        // `Place` — closes the WR-01-class TOCTOU for the `Rotate` gesture (CR-01): a
        // pending `Rotate` changes which cells a node occupies (anchor-fixed
        // re-expand), and was previously invisible here, so a same-tick `Rotate A` +
        // `Place B` (or two overlapping `Rotate`s) both validated against stale
        // occupancy and the CLAIM-never-EVICT fold silently overwrote a body cell —
        // producing a `Core` that then FAILS its own `validate_invariants`
        // (`CellCollision`) on the next `restore()`. Replaying the pending edits makes
        // host validation see the same post-fold geometry.
        let mut owner = self.core.state.occupied(cell);
        for (idx, e) in self.pending_edits.iter().enumerate() {
            match e.op {
                EditOp::Place { cell_x, cell_y, w, h, rot, .. } => {
                    // A pending placement has no minted NodeId yet, so a cell its FULL
                    // footprint (frozen w,h, expanded via `cells_of_footprint`, NOT
                    // just the anchor — WR-01 multi-cell TOCTOU, Pitfall 6) covers
                    // reports the reserved null key: occupied, but distinct from every
                    // live id (a Rotate self-check `owner == Some(node)` never matches
                    // it). The box is expanded at the record's own rotation (EDIT 13,
                    // plan 86-02): 0 for a forward placement, the captured turn for the
                    // re-Place of a Delete undo, exactly the cells the fold will claim.
                    if cells_of_footprint((cell_x, cell_y), w, h, rot).any(|c| c == cell) {
                        owner = Some(NodeId::null());
                    }
                }
                EditOp::Rotate { node, new_rot, .. } => {
                    // Free this node's PRE-rotate body, then claim its NEW-rot body —
                    // but against the node's EFFECTIVE pre-this-edit state, not a blind
                    // `core.state` read. `effective_body_upto(node, idx)` yields `None`
                    // when an EARLIER pending `Delete` already removed the node, so we
                    // never phantom-claim for a node the fold has deleted (the fold's
                    // `rotate_footprint` no-ops on a cell-less node) — closing the
                    // Delete-then-Rotate divergence (WR-01 #1). When present it frees the
                    // node's CURRENT body (its anchor + dims, rot advanced by EARLIER
                    // pending Rotates) and claims the new-rot body — matching successive
                    // folds, closing the double-Rotate divergence (WR-01 #2). Absent
                    // footprint ⇒ the faithful 1×1-rot0 default (a 1×1 rotate is a no-op).
                    if let Some((anchor, w, h, old_rot)) = self.effective_body_upto(node, idx) {
                        if owner == Some(node)
                            && cells_of_footprint(anchor, w, h, old_rot).any(|c| c == cell)
                        {
                            owner = None;
                        }
                        if cells_of_footprint(anchor, w, h, new_rot).any(|c| c == cell) {
                            owner = Some(node);
                        }
                    }
                }
                EditOp::Delete { node, .. } => {
                    // A pending Delete frees its cells (this also removes the prior
                    // false-REJECT of placing onto a cell a same-tick Delete frees).
                    if owner == Some(node) {
                        owner = None;
                    }
                }
                // Plan 74.1-23 (review WR-01): a port edit CAN move a machine's body. A
                // growing AddPort claims its growth cells (and on a turned machine shifts
                // the anchor), and a RemovePort carrying a `restore` shrinks the box back.
                // Free the node's body BEFORE this edit and claim its body AFTER it, both
                // read off the effective replay (the Rotate arm's shape), so a second
                // same-tick add is checked against the box the first one grows.
                //
                // Phase 76 (plan 76-07, CR-02): a LABEL RESIZE moves a body too. A
                // `Configure{Label}` grows or shrinks the label's box over its fixed anchor,
                // so it is freed and claimed by the same two statements: a grow takes its
                // new cells before a later same-pass Place, DrawBelt, Rotate or AddPort can
                // validate onto them, and a shrink gives its old cells back at once. The box
                // is the one `effective_geometry_upto` replays, the fold's clamp in ONE place.
                EditOp::AddPort { node, .. }
                | EditOp::Configure { node, config: MachineConfig::Label { .. }, .. }
                | EditOp::RemovePort { node, .. } => {
                    if let Some((anchor, w, h, rot)) = self.effective_body_upto(node, idx)
                        && owner == Some(node)
                        && cells_of_footprint(anchor, w, h, rot).any(|c| c == cell)
                    {
                        owner = None;
                    }
                    if let Some((anchor, w, h, rot)) = self.effective_body_upto(node, idx + 1)
                        && cells_of_footprint(anchor, w, h, rot).any(|c| c == cell)
                    {
                        owner = Some(node);
                    }
                }
                EditOp::Dock { .. } => {} // a Dock adds a LINK, not occupancy (11-06)
                // 12-01: no pending-occupancy effect — mirror the Dock arm (Unlink
                // only removes a link; the markers carry no topology).
                // 35-02 / 63-02: none of these ops reserves a GRID CELL, and that is a
                // property of their shapes, not a stage they are passing through.
                // DrawWire records a logical port connection and MINTS a Node::Wire — a
                // wire is cell-less, so a minted wire claims no cell and frees none.
                // A Configure writes a machine's config and moves no cell for every config
                // but a Label: since phase 76 a `Configure{Label}` re-boxes the label, and
                // it is handled by the free-then-claim arm above (plan 76-07, CR-02). Every
                // other Configure reaches this arm. Mirror the Dock/Unlink no-effect arm
                // (panic-free).
                //
                // A minted wire is NOT invisible to this file, only to this OCCUPANCY
                // walk: `HostGridLookup::wire_from_port_exists` replays the same pending
                // edits to answer whether an output port already carries a wire.
                // The history seal (85-05, D-10) occupies nothing either.
                EditOp::Unlink { .. }
                | EditOp::Undo { .. }
                | EditOp::Redo { .. }
                | EditOp::DrawWire { .. }
                | EditOp::Configure { .. }
                | EditOp::SealHistory => {}
                EditOp::DrawBelt { ref tiles } => {
                    // A pending DrawBelt reserves each of its drawn tile cells
                    // (BELT-06): like a pending Place the belt has no minted NodeId
                    // yet, so a covered cell reports the reserved null key (occupied,
                    // distinct from every live id). No host GridCommand emits DrawBelt
                    // yet (11-05), but reconciling it keeps the EDITS-FIRST occupancy
                    // view correct when it does.
                    if tiles.iter().any(|t| t.cell == cell) {
                        owner = Some(NodeId::null());
                    }
                }
            }
        }
        owner
    }

    fn resolve(&self, handle: u64) -> Option<NodeId> {
        (self.resolve)(handle)
    }

    fn cell_of(&self, node: NodeId) -> Option<(i32, i32)> {
        // A pending `Delete` removes the node before this gesture folds (EDITS-FIRST),
        // so it must read as cell-less — matching the headless `GridSession`, which
        // re-folds after every apply (WR-01). A rotate is anchor-fixed, so the anchor
        // cell itself never moves; only `core.state` deletion + the pending Delete
        // change presence.
        if self.pending_deleted(node) {
            return None;
        }
        // Plan 74.1-23: a pending growing AddPort on a turned machine shifts the anchor,
        // so the anchor is read off the effective replay when a port edit is pending.
        if self.pending_ports.contains_key(&node) {
            return self.effective_body_upto(node, self.pending_edits.len()).map(|b| b.0);
        }
        self.core.state.cell_of(node)
    }

    fn kind_of(&self, node: NodeId) -> Option<u8> {
        // A pending `Delete` makes the node absent for the fold; report `None` so a
        // later same-tick gesture cannot capture a deleted node's kind (WR-01).
        if self.pending_deleted(node) {
            return None;
        }
        // Node AND ports from the SAME core, keyed by the SAME id. A Handler is a
        // `Node::Factory` distinguished only by its port list, so passing another
        // node's ports would compile and name the wrong machine.
        //
        // Plan 74.1-32 (review round 4 IN-01): the port list is the one `ports_of` answers,
        // so a pending port edit that changes what the machine is reads here as it will fold.
        self.core.state.node(node).map(|n| kind_byte(n, self.ports_of(node)))
    }

    fn link_exists(&self, from: (NodeId, fabrico_core::ids::PortId)) -> bool {
        // The output-port occupancy view (GridLookup contract). The folded link map is
        // the base authority; REPLAY this tick's pending edits in enqueue order, the same
        // effective view the EDITS-FIRST fold produces, as `wire_from_port` replays
        // `DrawWire`:
        // - a `Delete` of the source node frees the port again (WR-01);
        // - a pending `Dock` whose link source is `from` takes it (review round 5 WR-02,
        //   plan 74.1-35). `fold_dock` links with a bare insert, so before this a second
        //   Dock naming the same source in one drain pass was accepted and REPLACED the
        //   first: both answered Ok and the first join was gone with no word. Plan
        //   74.1-30's owed Docks for belts drawn while paused all go out on the same echo
        //   packet after Play, so they land in one pass. The link source is the one
        //   `fold_dock` inserts on: `(belt, 0)` for a Head dock, `(node, port)` for a Tail
        //   dock, `port` being the link key the Dock arm froze;
        // - a pending `Unlink` of that same source frees it again (`fold_unlink`).
        // (17-02 removed the node-to-node `Wire` edit that used to set a port occupied
        // here; belts dock via `Dock`, now replayed above beside the folded base.)
        //
        // Plan 74.1-32 (review round 4 IN-01): `from` names a POST-pass Out routing key (the
        // numbering `ports_of` answers), and the folded links are still keyed pre-pass, so
        // the key is mapped back through this pass's pending port edits before the read.
        // A pending Dock or Unlink froze its key in the numbering of the state just before
        // it, so `from` is mapped back to that position (`key_before(.., pos, ..)`) for the
        // comparison, which is the re-key the fold will apply to that link afterwards.
        let mut exists = self
            .key_before(from.0, from.1, 0, KeySpace::OutRouting)
            .is_some_and(|k| self.core.state.link_target((from.0, k)).is_some());
        let names_from = |pos: usize, source: (NodeId, fabrico_core::ids::PortId)| {
            source.0 == from.0 && self.key_before(from.0, from.1, pos, KeySpace::OutRouting) == Some(source.1)
        };
        let source_of = |belt: NodeId, endpoint: fabrico_core::edit::BeltEnd, node: NodeId, port| match endpoint {
            fabrico_core::edit::BeltEnd::Head => (belt, 0),
            fabrico_core::edit::BeltEnd::Tail => (node, port),
        };
        for (pos, e) in self.pending_edits.iter().enumerate() {
            match e.op {
                EditOp::Delete { node, .. } if node == from.0 => exists = false,
                EditOp::Dock { belt, endpoint, node, port } if names_from(pos, source_of(belt, endpoint, node, port)) => {
                    exists = true;
                }
                EditOp::Unlink { belt, endpoint, node, port } if names_from(pos, source_of(belt, endpoint, node, port)) => {
                    exists = false;
                }
                _ => {}
            }
        }
        exists
    }

    fn wire_from_port(&self, from: (NodeId, fabrico_core::ids::PortId)) -> Option<NodeId> {
        // The wire half of the output-port occupancy view (63-02). The folded nodes are
        // the base authority; REPLAY this tick's pending edits in enqueue order so a
        // `DrawWire` already enqueued THIS tick counts (the same TOCTOU `occupied_by`
        // guards against, WR-01) and a same-tick `Delete` of the source node frees the
        // port again. Deterministic: `node_ids` walks a `BTreeMap` and the pending
        // buffer is an ordered `Vec` we never sort or dedup.
        //
        // 72-08: this used to answer the BOOLEAN `wire_from_port_exists` directly. It
        // now answers with the ID and the boolean is the trait's default on top of it.
        //
        // A PENDING `DrawWire` HAS NO NODE ID YET, which is the one asymmetry between
        // the two answers and it is stated here rather than left for a reader to hit.
        // The wire it will mint does not exist until the fold, so the pending replay can
        // only ever say "this port is now BUSY" (`Some(NodeId::null())`) or "now free"
        // (`None`). The sentinel is never dereferenced: the only caller that reads the
        // id is the paired delete, and a delete resolves a node that has already FOLDED,
        // so its `from` port can never be one a pending record just claimed. The
        // occupancy check reads only `is_some()`, which is the answer this half exists
        // to give.
        //
        // Plan 74.1-32 (review round 4 IN-01): `from` names a POST-pass catalog index, so it
        // is mapped back through the pending port edits that come AFTER each wire's origin
        // (all of them for a folded wire, those behind it for a pending draw) before the
        // comparison, which is the re-key the fold will apply to that wire's endpoint.
        let base = self.key_before(from.0, from.1, 0, KeySpace::Catalog);
        let mut found = base.and_then(|k| {
            self.core
                .state
                .node_ids()
                .find(|&id| matches!(self.core.state.node(id), Some(Node::Wire(w)) if w.from == (from.0, k)))
        });
        for (pos, e) in self.pending_edits.iter().enumerate() {
            match e.op {
                EditOp::DrawWire {
                    from_node,
                    from_port,
                    ..
                } if from_node == from.0
                    && self.key_before(from.0, from.1, pos, KeySpace::Catalog) == Some(from_port) =>
                {
                    found = Some(NodeId::null());
                }
                EditOp::Delete { node, .. } if node == from.0 => found = None,
                _ => {}
            }
        }
        found
    }

    fn wire_touches_port(&self, at: (NodeId, fabrico_core::ids::PortId)) -> bool {
        // 73-12 (73-REVIEW CR-02). The SAFETY question a `RemovePort` asks: is any cable
        // attached at this port, on EITHER of its endpoints. The folded nodes are the base
        // authority; this tick's pending edits are REPLAYED in enqueue order for the same
        // TOCTOU reason `wire_from_port` above replays them - a `DrawWire` enqueued this
        // tick has not folded yet, and a same-tick `Delete` of the wire or of either
        // endpoint node frees the port again.
        //
        // A PENDING `DrawWire` HAS NO NODE ID YET, which does not matter here: this answer
        // is a boolean and never names the wire. Both endpoints of a pending draw are
        // checked, unlike `wire_from_port`'s source-only occupancy question.
        //
        // Plan 74.1-32 (review round 4 IN-01): `at` names a POST-pass catalog index, mapped
        // back exactly as `wire_from_port` maps it.
        let mut touched = self.key_before(at.0, at.1, 0, KeySpace::Catalog).is_some_and(|k| {
            let pre = (at.0, k);
            self.core.state.node_ids().any(|id| {
                matches!(
                    self.core.state.node(id),
                    Some(Node::Wire(w)) if w.from == pre || w.to == pre
                )
            })
        });
        for (pos, e) in self.pending_edits.iter().enumerate() {
            let pre = self.key_before(at.0, at.1, pos, KeySpace::Catalog).map(|k| (at.0, k));
            match e.op {
                EditOp::DrawWire {
                    from_node,
                    from_port,
                    to_node,
                    to_port,
                } if pre.is_some_and(|pre| (from_node, from_port) == pre || (to_node, to_port) == pre) => {
                    touched = true;
                }
                // A pending Delete of the MACHINE takes every cable on it with it
                // (`remove_node`'s wire cascade), so the port is free either way.
                EditOp::Delete { node, .. } if node == at.0 => touched = false,
                _ => {}
            }
        }
        touched
    }

    fn wire_endpoints(
        &self,
        wire: NodeId,
    ) -> Option<(
        (NodeId, fabrico_core::ids::PortId),
        (NodeId, fabrico_core::ids::PortId),
    )> {
        // A pending `Delete` makes the wire absent for the fold (WR-01), mirroring
        // `kind_of`/`ports_of`: a same-tick second gesture must not read a wire this
        // tick already removed.
        if self.pending_deleted(wire) {
            return None;
        }
        match self.core.state.node(wire) {
            Some(Node::Wire(w)) => Some((w.from, w.to)),
            _ => None,
        }
    }

    fn is_route(&self, node: NodeId) -> bool {
        if self.pending_deleted(node) {
            return false;
        }
        self.core.state.node(node).is_some_and(is_route_shape)
    }

    fn is_handler(&self, node: NodeId) -> bool {
        if self.pending_deleted(node) {
            return false;
        }
        // Node AND ports from the SAME core, keyed by the SAME id, handed to the ONE
        // shared predicate. The headless producer's body is the same two lines.
        // Plan 74.1-32: the port list `ports_of` answers, as `kind_of` reads it.
        self.core.state.node(node).is_some_and(|n| is_handler_shape(n, self.ports_of(node)))
    }

    fn ports_of(&self, node: NodeId) -> Option<&[Port]> {
        // A pending `Delete` removes the node (WR-01); otherwise the frozen rot-0 ports
        // read straight from the single core.state source (one validation path). A
        // rotation does NOT change the rot-0 port declarations — `port_world` applies
        // the orientation at dock-check time using `footprint_of`'s effective `rot`.
        if self.pending_deleted(node) {
            return None;
        }
        // Plan 74.1-23: a node a pending AddPort/RemovePort names answers the list those
        // edits leave, so a second same-tick port edit sees the first.
        if let Some(ports) = self.pending_ports.get(&node) {
            return Some(ports);
        }
        self.core.state.ports_of(node)
    }

    fn footprint_of(&self, node: NodeId) -> Option<Footprint> {
        // Present the EFFECTIVE footprint after THIS tick's pending edits: a pending
        // `Delete` makes it `None`; a pending `Rotate` advances `rot` so a SECOND
        // same-tick `Rotate`'s `validate_normalize` reads the post-first-rotate
        // orientation and resolves the user's SECOND quarter-turn — instead of
        // re-deriving the first from stale rot0 and silently dropping a turn (WR-01 #2)
        // — and a same-tick Wire dock validation sees the post-rotate port world-cells.
        // A live belt (no cell) keeps the faithful 1×1-rot0 default, matching the
        // headless producer (`GridViewLookup::footprint_of`).
        if self.pending_deleted(node) {
            return None;
        }
        let _live = self.core.state.node(node)?;
        match self.effective_body_upto(node, self.pending_edits.len()) {
            Some((_, w, h, rot)) => Some(Footprint { w, h, rot }),
            None => Some(Footprint { w: 1, h: 1, rot: 0 }),
        }
    }

    fn belt_geometry(&self, node: NodeId) -> Option<&[BeltTile]> {
        // A pending `Delete` removes the belt (WR-01); otherwise the drawn geometry
        // reads straight from the single core.state belt node (one validation path,
        // matching the headless `GridViewLookup`). A non-belt or a Wire-minted belt
        // (empty geometry) yields None -> not dockable.
        //
        // A live `Node::Wire` resolves as a CARRIER with an EMPTY tile list (74-06,
        // LINK-05), mirroring the headless `GridViewLookup` clause word for word. This
        // half is not optional: the two implementations are the host-side and headless
        // halves of ONE accept envelope, and widening only one would let a gesture the
        // command layer accepts be refused by the running app, or the reverse.
        if self.pending_deleted(node) {
            return None;
        }
        match self.core.state.node(node)? {
            Node::Belt(b) if !b.geometry.is_empty() => Some(&b.geometry),
            Node::Wire(_) => Some(&[]),
            _ => None,
        }
    }

    fn endpoint_path_owner(&self, path: &str, excluding: NodeId) -> Option<NodeId> {
        // The headless `GridViewLookup` answer, read from the board the fold will see, as
        // `links_touching` and `fold_belt_at` read it (phase 91 review CR-A-01). On a paused
        // board the pass holds every queued gesture, so the folded core alone is the wrong
        // board three ways: a pending Place of a Route has not minted its `/route-N` yet (D-13
        // made that number the first path a user would type, and two Routes then folded onto
        // one path, `project_routes` keeping one with no word); a pending Configure that
        // renames a Route away from a path still reads as holding it (a false refusal); and a
        // pending Delete's Route still reads as holding its path. The scratch fold answers all
        // three with the core's own fold, so the two producers keep ONE accept envelope
        // (`GridSession` folds each command before the next validates). `excluding` names a
        // folded node, and the scratch board keeps every folded id.
        //
        // Paths compare by the Route key the host routes on (WR-A-04), as the headless read does.
        let board = self.board_after_pending();
        board.state.node_ids().find(|&id| {
            id != excluding
                && matches!(
                    board.state.node(id),
                    Some(Node::Endpoint(ep)) if fabrico_core::edit::same_route_key(&ep.path, path)
                )
        })
    }

    fn links_touching(&self, node: NodeId) -> Vec<((NodeId, fabrico_core::ids::PortId), (NodeId, fabrico_core::ids::PortId))> {
        // The headless `GridViewLookup` reads its folded core; this half reads the board the
        // fold will see, which is the same core when nothing is pending. On a paused board a
        // turn back validated after a pending turn away therefore sees the dock that turn will
        // cut as cut (research Pitfall 1), and the two producers keep ONE accept envelope.
        self.board_after_pending()
            .state
            .links_iter()
            .filter(|(from, to)| from.0 == node || to.0 == node)
            .collect()
    }

    fn fold_belt_at(&self, cell: (i32, i32)) -> Option<(NodeId, &[BeltTile])> {
        // The same board `links_touching` reads (review CR-A-01, WR-A-01): a belt a pending
        // DrawBelt mints is there under the id the real fold gives it, and a belt a pending
        // Delete takes with its machine is gone, so the turn's re-dock agrees with the
        // headless session on a paused board.
        let board = self.board_after_pending();
        let id = board.state.occupied(cell)?;
        match board.state.node(id)? {
            Node::Belt(b) if !b.geometry.is_empty() => Some((id, &b.geometry)),
            _ => None,
        }
    }
}

/// Host-stamp a single [`EditOp::Configure`]'s `code_hash` with `blake3(source)` when
/// it configures a Factory (CFG-02). The `fabrico-command` layer is blake3-fenced and
/// emits `code_hash: [0u8; 32]`; the host owns the stamp. A non-Factory config
/// (Source/Sink — no JS) is left untouched at `[0u8; 32]`. Pure and idempotent: the
/// hash is a deterministic function of the exact authored bytes, so re-stamping an
/// already-stamped record yields the identical value.
fn stamp_factory_code_hash(op: &mut EditOp) {
    if let EditOp::Configure {
        config: MachineConfig::Factory { source },
        code_hash,
        ..
    } = op
    {
        *code_hash = *blake3::hash(source.as_bytes()).as_bytes();
    }
}

/// Apply [`stamp_factory_code_hash`] to every record in a compensating Undo/Redo group
/// (F2). `compute_inverse`'s undo arm builds a `Configure{Factory{source:PRIOR}}` with
/// the `[0u8; 32]` fence value; without this the undone record would persist a real
/// handler under a zeroed certification hash (a CFG-02 invariant violation). The redo
/// arm already carries the original `blake3(source)`, so the stamp is a no-op there.
fn stamp_factory_code_hashes(group: &mut [EditRecord]) {
    for record in group {
        stamp_factory_code_hash(&mut record.op);
    }
}

/// Validate a [`GridCommand`] through `fabrico-command` and — on accept — enqueue
/// exactly ONE RESOLVED [`EditRecord`](fabrico_core::edit::EditRecord) onto the host
/// EDIT LOG (via [`Host::enqueue_edit`], 08-05) so [`Host::tick_once`] stamps,
/// persists, and folds it EDITS-FIRST. The gesture is NEVER enqueued onto the
/// runtime event ingress (CMD-05).
///
/// `resolve` maps a dense `u64` render handle to its live [`NodeId`] (the inverse of
/// the render builder's handle table); `Place` ignores it.
///
/// This function NEVER writes `core.state` directly and NEVER panics — an invalid
/// gesture returns `Err(CommandError::*)` having mutated nothing (no enqueued edit,
/// no buffered cell), so the fold is the only mutator (SC5 / T-8-GESTURE-OPTIMISTIC).
/// One validation path, two producers: it runs the IDENTICAL
/// [`validate_normalize`] the headless `fabrico-command` crate runs (CMD-01).
///
/// # The Undo and Redo arms assume an EMPTY pending buffer (plan 74.1-23)
/// They resolve against the session's projection, which knows nothing of records
/// enqueued but not yet folded. Called with a non-empty `host.pending_edits()`, an Undo
/// would name the action BEFORE those records (GAP N3-RACE: a same-tick Ctrl+Z after a
/// join deleted the second belt). [`SimLoop::acquire_input`](crate::sim_loop::SimLoop)
/// guarantees the empty buffer: it applies an Undo or Redo only at the start of a drain
/// pass and holds one met later until the next pass.
///
/// # Errors
/// Returns the typed [`CommandError`] that fired: out-of-bounds / occupied /
/// unknown-kind (Place), unknown-node / incompatible-ports (Wire), unknown-node
/// (Delete).
pub fn apply_gesture(
    host: &mut Host,
    cmd: GridCommand,
    resolve: impl Fn(u64) -> Option<NodeId>,
) -> Result<(), CommandError> {
    // (0) Route the two transient Undo/Redo commands BEFORE validate_normalize,
    //     mirroring GridSession::apply's early route (command.rs:699-708). They are
    //     NEVER validated/normalized as themselves — the live path used to fall
    //     through to `validate_normalize`, which hits the `CommandError::Malformed`
    //     arm (the exact Phase 19 blocker). Instead ask the session's frozen `&self`
    //     compute half for the UNSTAMPED inverse group (the `EditOp::Undo`/`Redo`
    //     lineage marker + retargeted compensating Place/Delete records), then enqueue
    //     the WHOLE group under ONE SHARED action id so it is a single undo step. The
    //     markers fold EDITS-FIRST like any edit (CONTEXT Area 2 Q1); tick_once stamps
    //     partition/sequence/tick and folds them. On an empty stack resolve_* return a
    //     typed NothingToUndo/NothingToRedo which we PROPAGATE, enqueuing nothing (no
    //     mutation on reject — SC#2). The compensating records do the topology work;
    //     the markers are fold no-ops (input_apply.rs occupied_by + core advance_edits).
    match cmd {
        GridCommand::Undo => {
            // Re-stamp the compensating group's Factory configs (F2): a Configure undo
            // enqueues a `Configure{Factory{source:PRIOR}, code_hash:[0;32]}` (the
            // blake3-fenced command layer hardcodes the zero) — a REAL handler with a
            // zeroed certification hash, violating CFG-02's `code_hash == blake3(source)`
            // invariant. This early Undo/Redo route returns BEFORE the forward-path stamp
            // block below, so the host must apply the SAME stamp here.
            let mut group = host.session().resolve_undo()?;
            stamp_factory_code_hashes(&mut group);
            host.enqueue_action_group(group);
            return Ok(());
        }
        GridCommand::Redo => {
            // Same host stamp on the redo path (F2). A redo re-applies the ORIGINAL new
            // config, whose logged hash is already `blake3(source)`, so the stamp is
            // idempotent here — but applying it unconditionally keeps the invariant true
            // for every enqueued Factory Configure regardless of path.
            let mut group = host.session().resolve_redo()?;
            stamp_factory_code_hashes(&mut group);
            host.enqueue_action_group(group);
            return Ok(());
        }
        _ => {}
    }

    // (1) Validate against a read-only view of the live grid, producing the RESOLVED
    //     record. A reject returns here having mutated/enqueued nothing (SC#2). The
    //     adapter borrows the host immutably and is dropped before the mutable
    //     enqueue below.
    let mut group = {
        // This tick's already-enqueued edits — so a second same-tick same-cell Place
        // sees the first's cell before the core folds it (WR-01), and a second port
        // edit sees the box the first one leaves (74.1-23).
        let adapter = HostGridLookup::new(host.core(), host.pending_edits(), resolve);
        validate_normalize(&adapter, cmd)?
    };

    // (1a) EVERY `Delete` CARRIES ITS WHOLE CAPTURE, READ FROM THE BOARD ITS FOLD WILL SEE
    //     (plan 86-05, D-05). `validate_normalize` freezes `captured:
    //     DeletedSubgraph::default()` on purpose - it is a `&V: GridLookup` function and
    //     cannot reach a `GridState` - and `GridSession` fills it in afterwards via its own
    //     `enrich_delete_capture` (`command.rs`, 12-05). Until plan 73-03 this path never
    //     did: every Delete the shipped app wrote carried an empty capture, found only
    //     because the live spec was red while the `GridSession` tests were green.
    //
    //     WHICH BOARD. The capture is the material the Undo rebuilds from: the box, the
    //     turn, the ports, the belts and cables the Delete takes with the node (each with
    //     its links, keyed in the same port numbering as `ports`), and a bare belt's or
    //     wire's own record. It must describe the node AS THE FOLD DELETES IT. On a paused
    //     board every queued gesture folds in ONE drain pass, so the records ahead of this
    //     Delete (this pass's buffer, then this group's own earlier records) fold first,
    //     and the board before the pass is the wrong one:
    //     - an AddPort that grows the machine was lost (`probe_p1`; for a turned machine
    //       `probe_p3`, whose record mixed the moved anchor with the old box);
    //     - a Dock or a DrawWire made earlier in the pass puts a belt or a cable INTO the
    //       cascade, which the fold then takes with the machine and the Undo never drew
    //       back (`probe_d1_dock_then_delete`, `probe_d2_draw_wire_then_delete`);
    //     - an Unlink, a Rotate that releases a dock, or a Delete of the belt, the wire or
    //       a neighbour sharing it takes one OUT of the cascade, and the Undo drew it a
    //       second time (`probe_c1` to `probe_c7`, the 76-12 refuter round);
    //     - a label resized earlier in the pass came back at its old box over a neighbour
    //       (`shrink_place_delete_in_one_pass_then_undo_keeps_the_placed_machine_on_its_cell`).
    //     Two field-by-field patches covered the last two (a replayed label box written
    //     over the capture, and a prune that dropped cascade entries the fold would not
    //     take), and a third read the turn. A patched capture mixes two boards, which is
    //     the record the same-pass todo measured. So the WHOLE capture is read from ONE
    //     board: a scratch clone of the core advanced by every earlier record with the
    //     core's own fold (`advance_edits`, the pattern `capture_slice` uses), its commands
    //     and tick discarded. The fold mints ids in record order, so the clone's ids are
    //     the ones the real fold gives.
    //
    //     THE ORDER WITH PLAN 86-02. A same-pass box only became safe to capture once the
    //     capture carried the turn (EDIT 13): a turned Factory grown in the pass would
    //     otherwise be re-Placed as its grown box at rot 0, on cells it never held
    //     (`probe_p3_box_stays_inside_what_the_machine_held`).
    //
    //     THE FAST PATH. A Delete first in its group with nothing pending has no earlier
    //     record, so the board is `host.core()` itself: no clone is taken and the record's
    //     bytes are what they were before plan 86-05
    //     (`a_first_delete_with_nothing_pending_writes_the_same_capture`). Any other
    //     Delete costs one board clone, bounded by the drain pass (threat T-86-14).
    //
    //     Behaviour-neutral for every non-Delete op, and `fold_delete` never consumes
    //     `captured`, so no fold and no per-tick hash moves - only the recorded bytes.
    //
    //     A DELETE OF A NODE THE FOLD WILL NOT FIND IS REFUSED HERE (phase 86 review,
    //     CR-01). `HostGridLookup::pending_deleted` sees only a pending Delete that names a
    //     node DIRECTLY, so a belt or a cable an earlier Delete in the pass takes with its
    //     machine (the cascade) still validates as live. On the scratch board it is already
    //     gone: its capture would be read off nothing, and its Undo refused `Malformed` on
    //     every press, walling off every step below it (`probe_c8`, `probe_c9`). The scratch
    //     board is the one the fold sees, pending Docks and DrawWires included, so asking it
    //     is the cascade check with no second copy of the cascade rule. The answer is the one
    //     separate passes give, `UnknownNode`, and nothing has been enqueued yet.
    for i in 0..group.len() {
        let EditOp::Delete { node, .. } = group[i].op else {
            continue;
        };
        let capture = if i == 0 && host.pending_edits().is_empty() {
            host.core().state.capture_deleted_subgraph(node)
        } else {
            let mut board = host.core().clone();
            let earlier: Vec<EditRecord> =
                host.pending_edits().iter().chain(&group[..i]).cloned().collect();
            let _ = board.advance_edits(&earlier, &[]);
            if board.state.node(node).is_none() {
                return Err(CommandError::UnknownNode);
            }
            board.state.capture_deleted_subgraph(node)
        };
        if let EditOp::Delete { captured, .. } = &mut group[i].op {
            *captured = capture;
        }
    }

    // (1b) Host-stamp the Factory `code_hash` (CFG-02) — the blake3 digest of the EXACT
    //      authored JS bytes. This runs AFTER validate_normalize resolves the record
    //      (it needs the resolved config bytes) and BEFORE enqueue. The Undo/Redo
    //      intercept above applies the SAME stamp to its compensating group (F2), so
    //      EVERY enqueued Factory Configure carries a real blake3 hash regardless of
    //      path. The command layer freezes `code_hash: [0u8; 32]` (the blake3 fence — no
    //      hash in fabrico-command/fabrico-core runtime); the host overwrites it with
    //      `blake3(source.as_bytes())`. The stamp is a pure, deterministic function of
    //      the bytes; the core STORES the 32 bytes opaquely and NEVER computes/interprets
    //      them. A non-Factory config (Source/Sink) keeps [0u8; 32] — there is no JS to
    //      hash.
    for record in &mut group {
        stamp_factory_code_hash(&mut record.op);
    }

    // (2) Enqueue the RESOLVED records onto the EDIT log (the ONLY mutator path) under a
    //     FRESH SHARED action id (one undo step per normal gesture, CONTEXT Area 2 Q1):
    //     tick_once drains, stamps, persists, and folds them EDITS-FIRST (08-05). The
    //     grid changes only when the tick folds them (CMD-05). A `Place` cell lands
    //     in core `GridState` at fold time (09-02); no host-side cell buffer is kept.
    //
    //     `enqueue_action_group` rather than `enqueue_edit_with_new_action` since 72-08,
    //     because a Route-and-Handler drag now resolves to TWO records that must share
    //     ONE action id (D-04). For the one-record group every other command produces the
    //     two helpers are identical: `enqueue_action_group` takes `next_action`, bumps
    //     it, and stamps it onto each record, which for a single record IS
    //     `enqueue_edit_with_new_action`.
    host.enqueue_action_group(group);
    Ok(())
}

/// Apply ONE decoded [`GestureFrame`]: the drain's entry point since Phase 68.
///
/// A [`GestureFrame::Cmd`] delegates STRAIGHT to [`apply_gesture`], whose signature
/// and body are untouched (it still has callers in `demo_scene.rs`, four test files
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
