//! Applying a gesture to the engine: validate a place, wire or delete through the same
//! `fabrico-command` validation the headless harness uses, then enter it into the core only as
//! logged, resolved [`EditRecord`]s the fold applies. Nothing here writes grid state directly,
//! so replaying the edit log rebuilds the topology.
//!
//! A gesture is untrusted input, even one from our own webview. [`apply_gesture`] builds a
//! [`HostGridLookup`] over the core and this tick's enqueued edits and runs
//! [`validate_normalize`]. On a refusal it returns a typed [`CommandError`] and changes nothing.
//!
//! The commands carry the dense `u64` handles the frontend sees, not the core's generational
//! [`NodeId`], so the caller passes a `resolve` closure from handle to node.
//!
//! Enqueued edits fold first inside [`Engine::step`], so a gesture validated later in the same
//! tick has to see the cells earlier ones moved. [`HostGridLookup`] replays the enqueued buffer
//! on top of `core.state` to answer that.

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

use crate::engine::Engine;

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
#[doc(hidden)]
pub fn kind_byte(node: &Node, ports: Option<&[Port]>) -> u8 {
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
///   by `advance_edits`), not this replay and not the pre-pass core; `engine.core()` itself
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
/// - The host's `sim_loop.rs`: `acquire_input` (twice, the held Undo or Redo) and `tick_body`
///   (the Timer re-projection guard) ask `is_empty()` only and read no record.
/// - `engine.rs`: the `Engine` field, `enqueue_edit`, the `pending_edits` accessor and
///   `step`'s `take` are the buffer itself and the fold that drains it; `step` folds
///   `Configure{Label}` through `fold_configure`, the truth this replay mirrors.
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
#[doc(hidden)]
pub struct HostGridLookup<'a, F: Fn(u64) -> Option<NodeId>> {
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
    pub fn new(core: &'a Core, pending_edits: &'a [EditRecord], resolve: F) -> Self {
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
pub fn stamp_factory_code_hash(op: &mut EditOp) {
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
pub fn stamp_factory_code_hashes(group: &mut [EditRecord]) {
    for record in group {
        stamp_factory_code_hash(&mut record.op);
    }
}

/// Validate a [`GridCommand`] through `fabrico-command` and — on accept — enqueue
/// exactly ONE RESOLVED [`EditRecord`](fabrico_core::edit::EditRecord) onto the host
/// EDIT LOG (via [`Engine::enqueue_edit_with_new_action`], 08-05) so [`Engine::step`] stamps,
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
/// enqueued but not yet folded. Called with a non-empty `engine.pending_edits()`, an Undo
/// would name the action BEFORE those records (GAP N3-RACE: a same-tick Ctrl+Z after a
/// join deleted the second belt). The host's `SimLoop::acquire_input`
/// guarantees the empty buffer: it applies an Undo or Redo only at the start of a drain
/// pass and holds one met later until the next pass.
///
/// # Errors
/// Returns the typed [`CommandError`] that fired: out-of-bounds / occupied /
/// unknown-kind (Place), unknown-node / incompatible-ports (Wire), unknown-node
/// (Delete).
pub fn apply_gesture(
    engine: &mut Engine,
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
            let mut group = engine.session().resolve_undo()?;
            stamp_factory_code_hashes(&mut group);
            engine.enqueue_action_group(group);
            return Ok(());
        }
        GridCommand::Redo => {
            // Same host stamp on the redo path (F2). A redo re-applies the ORIGINAL new
            // config, whose logged hash is already `blake3(source)`, so the stamp is
            // idempotent here — but applying it unconditionally keeps the invariant true
            // for every enqueued Factory Configure regardless of path.
            let mut group = engine.session().resolve_redo()?;
            stamp_factory_code_hashes(&mut group);
            engine.enqueue_action_group(group);
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
        let adapter = HostGridLookup::new(engine.core(), engine.pending_edits(), resolve);
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
    //     record, so the board is `engine.core()` itself: no clone is taken and the record's
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
        let capture = if i == 0 && engine.pending_edits().is_empty() {
            engine.core().state.capture_deleted_subgraph(node)
        } else {
            let mut board = engine.core().clone();
            let earlier: Vec<EditRecord> =
                engine.pending_edits().iter().chain(&group[..i]).cloned().collect();
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
    engine.enqueue_action_group(group);
    Ok(())
}
