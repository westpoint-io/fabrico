//! The read-only grid projection the command layer validates against.
//!
//! [`GridLookup`] is the validation SEAM — the read-only view of grid occupancy and
//! handle resolution that BOTH command producers share ("one validation path, two
//! producers", CMD-01): the headless [`GridViewLookup`] here (a [`GridView`] paired
//! with the deterministic [`Core`]) AND the live host's adapter (`input_apply.rs`).
//! Because [`validate_normalize`](crate::command::validate_normalize) is generic over
//! `GridLookup`, the host reuses the IDENTICAL validation logic.
//!
//! # Single occupancy source (SPAT-01, Phase 9)
//! Cells + occupancy now live in core [`GridState`](fabrico_core::state::GridState)
//! (folded from the edit-log, captured in the snapshot — 09-02). Both producers READ
//! occupancy/cells straight from `core.state` (`occupied`/`cell_of`), so there is ONE
//! occupancy authority and no second projection can disagree (the dual-source
//! divergence class — host `Layout` vs core — is gone). [`GridView`] therefore keeps
//! ONLY the projections core does not own: the dense `u64`-handle ↔ `NodeId` table,
//! the per-node `machine_kind` cache, and the occupied-output-port set (WR-04). It
//! no longer maintains its own `cells` map.

use std::collections::{BTreeMap, BTreeSet};

use fabrico_core::core::Core;
use fabrico_core::ids::{NodeId, PortId};
use fabrico_core::state::{BeltTile, Footprint, Medium, Node, Port, Role};
use fabrico_protocol::machine_kind;

/// The read-only validation seam over grid occupancy + handle resolution.
///
/// Implemented by the headless [`GridViewLookup`] and the host's adapter
/// (`input_apply.rs`), so [`validate_normalize`](crate::command::validate_normalize)
/// validates IDENTICALLY for both producers. Every method is read-only and
/// **non-panicking**: an absent node / handle yields `None`, never an index panic
/// (T-8-CMD-PANIC).
pub trait GridLookup {
    /// The live node occupying `cell`, or `None` if the cell is free — the
    /// multi-cell collision read (V5, FOOT-01). Generalizes the boolean
    /// [`occupied`](Self::occupied): a caller that must EXCLUDE the moving node's own
    /// cells (a future Rotate re-check, 10-06) compares the returned id, while a
    /// `Place` (which has no moving self) treats any `Some` as a collision. The host
    /// producer additionally reports a same-tick pending `Place`'s FULL footprint as
    /// occupied (WR-01 multi-cell TOCTOU).
    fn occupied_by(&self, cell: (i32, i32)) -> Option<NodeId>;
    /// True iff some live node occupies `cell` (the Place occupancy check, V5).
    /// Derived from [`occupied_by`](Self::occupied_by) so both producers can never
    /// disagree on the boolean vs. the owning-node answer.
    fn occupied(&self, cell: (i32, i32)) -> bool {
        self.occupied_by(cell).is_some()
    }
    /// Resolve a dense `u64` render handle to its live [`NodeId`], or `None` for a
    /// stale / forged handle (the Wire/Delete resolution, T-8-CMD-PANIC).
    fn resolve(&self, handle: u64) -> Option<NodeId>;
    /// The grid cell `node` occupies, if any. Belts (no cell — W1) yield `None`.
    fn cell_of(&self, node: NodeId) -> Option<(i32, i32)>;
    /// The `machine_kind` byte of `node`, if it is live (read from the node
    /// variant). Used to capture the resolved kind at Delete time.
    fn kind_of(&self, node: NodeId) -> Option<u8>;
    /// True iff the output port `from` already feeds a link (the re-wire guard,
    /// WR-04). Re-wiring an already-connected output port would silently overwrite
    /// the existing `(from, from_port) -> belt` link and orphan that belt, so
    /// [`validate_normalize`](crate::command::validate_normalize) rejects it rather
    /// than letting `fold_wire`'s unconditional `link` insert leak topology.
    fn link_exists(&self, from: (NodeId, fabrico_core::ids::PortId)) -> bool;
    /// True iff a live [`Node::Wire`] already ORIGINATES at the output port `from`
    /// (its `WireLink.from == from`) — the wire half of the output-port occupancy
    /// check (WIRE-01, 63-02).
    ///
    /// # Why [`link_exists`](Self::link_exists) cannot answer this
    /// A drawn wire's ONE `links` entry is keyed on the WIRE's own port 0, never on
    /// the source machine's output port, so a second wire out of one output port is
    /// invisible to `link_exists`. The two predicates cover different halves of the
    /// same question and a `DrawWire` must ask BOTH: `link_exists` catches a belt
    /// docked to that port, this catches a wire already drawn from it.
    ///
    /// # What goes wrong without it
    /// `GridState::wire_from_node` picks the FIRST wire out of a node in ascending
    /// `NodeId` order, and its own docblock records the single-wire-per-endpoint
    /// topology it assumes. Two wires out of one node is therefore not a crash and not
    /// a determinism defect — it is a SILENT one: the lower-id wire always wins and the
    /// second is dead topology the user drew and can see (T-63-15).
    ///
    /// Read-only, non-panicking, deterministic (`nodes` is a `BTreeMap`).
    fn wire_from_port_exists(&self, from: (NodeId, fabrico_core::ids::PortId)) -> bool {
        self.wire_from_port(from).is_some()
    }
    /// The live [`Node::Wire`] whose SOURCE endpoint is exactly `from`, or `None` if
    /// that output port carries no wire (72-08). The strict generalisation of
    /// [`wire_from_port_exists`](Self::wire_from_port_exists), which is now DEFAULTED
    /// on top of it so the two answers cannot disagree.
    ///
    /// # Why the id and not just the boolean
    /// R-53's paired delete has to NAME the return leg, and the return leg is found by
    /// exactly the question the occupancy check already asks: "what wire leaves this
    /// output port". A second walk answering the same question in a second way is the
    /// drift this trait exists to prevent, so the walk answers once and the boolean is
    /// derived.
    ///
    /// Deterministic and non-panicking: `nodes` is a `BTreeMap`, so the FIRST match in
    /// ascending `NodeId` order is a stable answer. NO DEFAULT IMPLEMENTATION, for the
    /// [`endpoint_path_owner`](Self::endpoint_path_owner) reason: a default returning
    /// `None` would make one producer silently permissive.
    fn wire_from_port(&self, from: (NodeId, fabrico_core::ids::PortId)) -> Option<NodeId>;
    /// True iff ANY live [`Node::Wire`] names the port `at` on EITHER of its endpoints -
    /// its `WireLink.from` or its `WireLink.to` (73-12, 73-REVIEW CR-02).
    ///
    /// # Why this is not [`wire_from_port`](Self::wire_from_port) with a wider matcher
    /// They answer two different questions and the paragraph on `wire_from_port` about a
    /// second walk does not apply. `wire_from_port` asks the OCCUPANCY question - "is this
    /// OUTPUT already busy" - and must be source-only, because a wire ARRIVING at a port
    /// does not stop a second wire LEAVING it; it also has to name the wire, because R-53's
    /// paired delete needs the id. This asks the SAFETY question a `RemovePort` has to ask:
    /// "is any cable attached here at all", and an arriving cable counts every bit as much
    /// as a leaving one. Deriving one from the other would make one of the two silently
    /// wrong.
    ///
    /// # What it protects
    /// [`fold_remove_port`](fabrico_core::tick) re-points every wire endpoint ABOVE the
    /// removed port, and RELEASES the wire whose endpoint named the removed port itself.
    /// The release is correct but not INVERTIBLE from the command layer: restoring the
    /// cable needs a `DrawWire` plus its captured incident links, which is the `Delete`
    /// capture machinery, and a `RemovePort` record carries none of it. So the command
    /// layer refuses the gesture instead, with the sentence the panel already ships for a
    /// busy output. The fold's release branch stays for forged logs, which reach
    /// `advance_edits` without passing here.
    ///
    /// Deterministic and non-panicking: `nodes` is a `BTreeMap`. NO DEFAULT
    /// IMPLEMENTATION, for the [`endpoint_path_owner`](Self::endpoint_path_owner) reason -
    /// a default returning `false` would make one producer silently permissive, which on
    /// this method means silently destroying a cable.
    fn wire_touches_port(&self, at: (NodeId, fabrico_core::ids::PortId)) -> bool;
    /// The `(from, to)` endpoints of the live [`Node::Wire`] `wire`, or `None` if
    /// `wire` is not a live wire (72-08).
    ///
    /// A wire's endpoints are recorded INSIDE its `WireLink` node and NOT in the
    /// `links` map (the only `links` entry a wire ever gets is the forward
    /// `(wire, 0) -> to` one), so this read cannot be derived from `link_exists` and is
    /// its own primitive. NO DEFAULT IMPLEMENTATION, same reason as above.
    fn wire_endpoints(
        &self,
        wire: NodeId,
    ) -> Option<(
        (NodeId, fabrico_core::ids::PortId),
        (NodeId, fabrico_core::ids::PortId),
    )>;
    /// True iff `node` is a live Route (a [`Node::Endpoint`]), the Route half of the
    /// R-51 pairing predicate (72-08).
    ///
    /// # Why this is a trait method and not `kind_of(node) == Some(ENDPOINT)`
    /// History, kept because the reason shaped this method: until phase 86 the headless
    /// [`kind_of`](Self::kind_of) read a kind byte cached when a node was minted, so a
    /// Factory port-edited into a Handler shape (`bless_fixtures.rs` scenario 07) read
    /// FACTORY headless and HANDLER host-side, and a pairing predicate built on
    /// `kind_of` would have fired in one producer only. Since phase 86 (WORK-06, D-07)
    /// that cache is gone and `kind_of` reads the LIVE node and its LIVE ports in both
    /// producers too, so `kind_of(node) == Some(ENDPOINT)` would now agree; this method
    /// and [`is_handler`](Self::is_handler) still read the live node directly, which is
    /// the only way the one validation path stays one.
    ///
    /// NO DEFAULT IMPLEMENTATION, same reason as
    /// [`endpoint_path_owner`](Self::endpoint_path_owner).
    fn is_route(&self, node: NodeId) -> bool;
    /// True iff `node` is live and satisfies the HANDLER naming predicate
    /// ([`is_handler_shape`], D-26 / R-37), the Handler half of R-51 (72-08).
    ///
    /// The RULE is not restated by either producer: both read the live node plus its
    /// live ports and hand them to [`is_handler_shape`]. See
    /// [`is_route`](Self::is_route) for why neither goes through `kind_of`.
    fn is_handler(&self, node: NodeId) -> bool;
    /// The live node's resolved rot-0 [`Port`] declarations (dock validation,
    /// FOOT-03), or `None` for a port-less / non-live node. A [`PortId`] indexes this
    /// slice. Read straight from the single `core.state.ports` source by BOTH
    /// producers, so a dock validates identically headless and host-side.
    fn ports_of(&self, node: NodeId) -> Option<&[Port]>;
    /// The live node's [`Footprint`] (dims + rot) so [`port_world`](fabrico_core::state::port_world)
    /// can place a declared port in world space, or `None` for a non-live node. A
    /// live node with no explicit footprint resolves to the faithful 1×1-rot0 default
    /// (absent ⇒ 1×1, the catalog-independent baseline).
    fn footprint_of(&self, node: NodeId) -> Option<Footprint>;
    /// The DRAWN `geometry` tiles of a live belt `node`, or `None` if `node` is not a
    /// live belt OR has empty geometry (the dock validation read, 11-06/BELT-05). The
    /// Dock arm reads the belt's HEAD (last tile) / TAIL (first tile) endpoint cell
    /// from this to validate adjacency + facing against the machine port. A
    /// `Wire`-minted BELT carries EMPTY geometry, so it yields `None` and cannot be
    /// docked — only player-drawn belts have spatial endpoints. Read straight from the
    /// single `core.state` belt node by BOTH producers, so a dock validates identically
    /// headless and host-side.
    ///
    /// # The one carrier that answers `Some` with nothing in it
    /// A live [`Node::Wire`](fabrico_core::state::Node::Wire) resolves to an EMPTY tile
    /// list (74-06, LINK-05), because a wire occupies no cells and has no spatial rule
    /// to be judged by. That is what makes an `Unlink` of a hand-drawn wire reversible
    /// through the same `Dock` verb that would have made it. BOTH implementations of
    /// this trait carry the clause; a single-sided widening would give the host and the
    /// headless session two different accept envelopes for one gesture.
    fn belt_geometry(&self, node: NodeId) -> Option<&[BeltTile]>;
    /// The live [`Node::Endpoint`] whose COMMITTED `path` equals `path`, EXCLUDING
    /// `excluding` (SERVE-08, D-13, R-47 rule 4). `None` if the address is free.
    ///
    /// # Why `excluding` is a parameter rather than a caller-side comparison
    /// A Route re-applying its OWN committed path is not a duplicate. Without this
    /// argument the rule would refuse a user who opens the config panel and presses
    /// Apply twice, which is a refusal nobody could act on.
    ///
    /// # Why it RETURNS the owner rather than answering a boolean
    /// The typed refusal ([`CommandError::DuplicatePath`](crate::CommandError)) is
    /// payload-free by the taxonomy's `Copy` discipline, so the owner's id does not ride
    /// it. The signature carries it anyway because the panel is where the owner gets
    /// NAMED (D-13), and a boolean here would mean that half of the answer never exists
    /// at the one place that can compute it.
    ///
    /// This is the ONLY one of R-47's four rules that needs the whole board to answer,
    /// which is why it is a lookup and the other three are a pure predicate
    /// ([`fabrico_core::edit::endpoint_path_is_valid`]).
    ///
    /// Deterministic and non-panicking: `nodes` is a `BTreeMap`, so the first match in
    /// ascending `NodeId` order is a stable answer.
    ///
    /// NO DEFAULT IMPLEMENTATION, deliberately. A default returning `None` would make
    /// the host producer silently permissive while the headless one refused, which is
    /// the two-producers-disagree defect this whole trait exists to prevent; without a
    /// default, the host implementer is a compile error instead.
    fn endpoint_path_owner(&self, path: &str, excluding: NodeId) -> Option<NodeId>;
    /// Every `links` entry that names `node` on either side, `(from, to)`, in ascending
    /// key order, read from THE BOARD THE FOLD WILL SEE (phase 89, D-08, research
    /// Finding B).
    ///
    /// # What it is for
    /// The Rotate arm of [`validate_normalize`](crate::command::validate_normalize) docks
    /// every loose belt end a turned machine's port faces at its new rotation. It must know,
    /// AFTER the turn, which belt ends still hold a dock and which of the machine's ports
    /// still hold one. Asked for a belt, this answers both of its ends: a link whose `from`
    /// is `(belt, 0)` is its Head's one dock, a link whose `to` is `(belt, 0)` is a dock into
    /// its Tail (several since LINK-13). Asked for the turned machine, it answers every dock
    /// the turn will judge. The command layer then applies the turn's own facing verdict to
    /// the machine's docks, the rule `GridState::dock_still_reaches` encodes.
    ///
    /// # Why the board the fold will see, and why that matters only to the host
    /// The headless session folds every command before the next is validated, so its core
    /// IS that board. The host validates a whole drain pass before any of it folds, and on
    /// a paused board a turn away and a turn back are validated back to back: the turn back
    /// must see the dock the turn away will cut as cut (research Pitfall 1). The host answers
    /// from a scratch clone of its core advanced by every pending record, the board plan
    /// 86-05's Delete capture already reads. A pending turn's severances are derived inside
    /// the fold, so no replay of the pending list short of the fold itself can answer this.
    ///
    /// Deterministic (`links` is a `BTreeMap`) and non-panicking: an absent node answers an
    /// empty list. NO DEFAULT IMPLEMENTATION, for the
    /// [`endpoint_path_owner`](Self::endpoint_path_owner) reason: a default answering the
    /// pre-pass links would leave the host's paused double turn undocked while every
    /// headless test passed, which is the two-producers-disagree defect this trait prevents.
    fn links_touching(&self, node: NodeId) -> Vec<((NodeId, PortId), (NodeId, PortId))>;
    /// The drawn belt owning `cell`, with its tiles, read from THE BOARD THE FOLD WILL SEE
    /// (the [`links_touching`](Self::links_touching) board). `None` when no belt with drawn
    /// geometry stands on `cell` there.
    ///
    /// # What it is for, and why `occupied_by` plus `belt_geometry` cannot answer it
    /// The Rotate arm's re-dock (D-08) asks which belt end sits on a turned port's doorstep.
    /// On a paused board the host validates a whole drain pass before any of it folds, and
    /// its `occupied_by` replay reports a cell a pending `DrawBelt` reserves as the null id
    /// (the belt has no id yet), while `belt_geometry` reads only the pre-pass core and keeps
    /// answering for a belt a pending Delete takes with its machine. Both were wrong for the
    /// turn: a belt drawn earlier in the pass was never docked (review CR-A-01) and a belt
    /// deleted earlier in the pass got a dead Dock (WR-A-01), while the headless session,
    /// which folds before it validates, did neither. The scratch board mints a pending belt
    /// under the id the real fold gives it (same allocator state, same record order), so a
    /// Dock can name it.
    ///
    /// NO DEFAULT IMPLEMENTATION, for the [`endpoint_path_owner`](Self::endpoint_path_owner)
    /// reason.
    fn fold_belt_at(&self, cell: (i32, i32)) -> Option<(NodeId, &[BeltTile])>;
}

/// The headless read-only grid projection — a pure fold of the accepted edit-log.
///
/// Holds ONLY the projections core [`GridState`](fabrico_core::state::GridState) does
/// not own (occupancy + cells live in `core.state` now — SPAT-01):
/// - the dense-handle table `handle_to_node` (+ its `node_to_handle` reverse) so a
///   `GridCommand`'s `u64` handle resolves to a live `NodeId` (the host's `resolve`
///   model, `input_apply.rs`).
/// - `from_ports`: every occupied output port `(NodeId, PortId)` (WR-04).
///
/// Pair it with the [`Core`] via [`lookup`](Self::lookup) to obtain a
/// [`GridViewLookup`] that implements [`GridLookup`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GridView {
    /// Dense `u64` render handle → live `NodeId`.
    handle_to_node: BTreeMap<u64, NodeId>,
    /// Reverse of `handle_to_node`, so a removed node frees its handle entry.
    node_to_handle: BTreeMap<NodeId, u64>,
    /// Monotonic next dense handle to assign (host-assigned, dense, in mint order).
    next_handle: u64,
    /// Every occupied output port `(NodeId, PortId)` — the `from` endpoint of a live
    /// link (WR-04). Rebuilt from the folded `core.state.links_iter()` each
    /// `apply_tick`, so it stays consistent with the authoritative topology (which is
    /// what the host's adapter reads directly). Backs [`GridLookup::link_exists`] so a
    /// re-wire of an already-connected port is rejected instead of silently
    /// overwriting the link and orphaning its belt. `BTreeSet` (NO `HashSet`) keeps
    /// the projection's determinism discipline.
    from_ports: BTreeSet<(NodeId, PortId)>,
}

/// THE HANDLER NAMING PREDICATE (D-26, ruling R-37 of plan 72-06). The ONE place the
/// rule is written: a [`Node::Factory`] is NAMED a Handler iff its port 0 is an
/// electrical [`Role::In`] AND at least one of its ports is an electrical
/// [`Role::Out`].
///
/// # Why this lives here, in `fabrico-command`
/// Three kind mappers need it: this module's [`kind_byte`], `fabrico-host`'s
/// `render_packet::machine_kind_of` and `fabrico-host`'s `input_apply::kind_byte`.
/// `fabrico-host` ALREADY depends on `fabrico-command` (the "one validation path, two
/// producers" seam), so this home adds NO dependency edge. The alternative homes were
/// `fabrico-core` (which would put a HOST-SIDE NAMING question inside the deterministic
/// core, where it decides nothing) and three private copies (which is the drift the
/// comment on each mapper already warns about, written three times).
///
/// # It is DELIBERATELY STRICTER than the servicing predicate, and they must never merge
/// [`fabrico_core::admit::inbox_class`] answers a DIFFERENT question: "is this delivery
/// a wire request", decided by port 0's declared medium ALONE (D-16, plan 72-03). This
/// function answers "what is this machine CALLED", and it demands an electrical Out as
/// well. THIS ONE IS STRICTER, on purpose (R-6, R-37).
///
/// The consequence, stated so nobody later reads the gap as a bug: a machine can be
/// SERVICED as a handler without being NAMED one. Goldens 0023 and 0024 are exactly
/// that case once plan 72-12 seeds their handlers an electrical In: they will be
/// serviced, and they will still report `FACTORY`, because they have no electrical Out
/// and therefore no way to send an answer back. Naming one of them a Handler would be
/// the overstating-label defect SERVE-03 exists to close. D-26 rejected the cheaper
/// "port 0 is Electrical" rule for exactly that reason, and rejected leaving the demo
/// board alone because that left one machine doing the handler's job under the other
/// machine's name; it upgraded the demo board instead.
///
/// # `ports` is `Option`, and `None` is not a Handler
/// A port-less node has no declared port 0 at all. `inbox_class` reads an undeclared
/// port as Mechanical (its clause 3), so a port-less Factory is neither serviced as a
/// handler nor named one, and the two predicates agree on that case.
#[must_use]
pub fn is_handler_shape(node: &Node, ports: Option<&[Port]>) -> bool {
    if !matches!(node, Node::Factory(_)) {
        return false;
    }
    let Some(ports) = ports else {
        return false;
    };
    let electrical_in_at_zero = matches!(
        ports.first(),
        Some(Port {
            role: Role::In,
            medium: Medium::Electrical,
            ..
        })
    );
    let has_electrical_out = ports
        .iter()
        .any(|p| p.role == Role::Out && p.medium == Medium::Electrical);
    electrical_in_at_zero && has_electrical_out
}

/// THE ROUTE NAMING PREDICATE (72-08). A Route is a [`Node::Endpoint`] and nothing
/// else, so unlike [`is_handler_shape`] it reads no ports.
///
/// It exists as a named function rather than an inline `matches!` for one reason: the
/// two producers must ask the SAME question, and a `matches!` written twice is two
/// questions that happen to agree today. It is the Route half of the pair
/// [`is_handler_shape`] is the Handler half of.
#[must_use]
pub fn is_route_shape(node: &Node) -> bool {
    matches!(node, Node::Endpoint(_))
}

/// Map a live [`Node`] variant plus its declared `ports` to its shared `machine_kind`
/// byte (the single source of truth is [`fabrico_protocol::machine_kind`]). Total over
/// every variant.
///
/// `pub(crate)` (not private) so `command.rs`'s inverse target-identity guard reads
/// the SAME mapping the projection does — two kind mappings that can disagree would
/// be a worse defect than the one that guard exists to stop. Crate-local: no API is
/// added to any frozen crate.
///
/// # Why it takes `ports` (72-06, D-26)
/// A Handler IS a [`Node::Factory`] (D-11 adds no `Node` variant), so the node alone
/// cannot distinguish the two and this function CANNOT emit `HANDLER` without reading
/// `GridState.ports`. The rule itself is NOT restated here: it is
/// [`is_handler_shape`], which the two `fabrico-host` mappers call as well. Three
/// restatements of one rule is precisely the drift the paragraph above warns about.
pub(crate) fn kind_byte(node: &Node, ports: Option<&[Port]>) -> u8 {
    match node {
        Node::Source(_) => machine_kind::SOURCE,
        Node::Belt(_) => machine_kind::BELT,
        Node::Tee(_) => machine_kind::TEE,
        Node::Balancer(_) => machine_kind::BALANCER,
        Node::Merge(_) => machine_kind::MERGE,
        Node::Router(_) => machine_kind::ROUTER,
        // FACTORY or HANDLER, decided by the SHARED predicate and by nothing local.
        Node::Factory(_) => {
            if is_handler_shape(node, ports) {
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

impl GridView {
    /// An empty projection (no node placed yet).
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold ONE tick's accepted topology edits into the projection from
    /// `core.last_tick`, assigning dense handles. Cells are NO
    /// longer projected here: the 09-02 fold writes each `Place`'s cell into core
    /// `GridState`, so occupancy/cells are read straight from `core.state` (SPAT-01).
    ///
    /// For each id in `core.last_tick.placed` (fold order), assign the next dense `u64`
    /// handle (EVERY minted id, node AND belt, gets one, as both `NodeView`/`BeltView`
    /// carry a handle on the wire). No kind byte is kept here: since phase 86 (WORK-06,
    /// D-07) [`GridLookup::kind_of`] reads the live node and its live ports, so a port
    /// edit that changes what a machine is can never leave a stale byte behind.
    ///
    /// Then every `core.last_tick.removed` id is dropped from the handle table (its
    /// handle freed), so the view never holds a dangling entry. Finally the
    /// occupied-output-port set is re-derived from the authoritative folded links.
    pub fn apply_tick(&mut self, core: &Core) {
        for &id in &core.last_tick.placed {
            // A minted id (node OR belt) gets a handle. Cells are not projected here
            // (they ride in core.state, SPAT-01), and neither is the kind (read live).
            match core.state.node(id) {
                Some(_) => self.assign_handle(id),
                // Minted-then-gone this tick (cannot happen for a single Phase-8
                // command): skip.
                None => continue,
            }
        }
        for id in &core.last_tick.removed {
            if let Some(handle) = self.node_to_handle.remove(id) {
                self.handle_to_node.remove(&handle);
            }
        }
        // Re-derive the occupied-output-port set from the authoritative folded links
        // (WR-04). Rebuilding (rather than incrementally patching) keeps it exact
        // across Wire mints AND Delete teardowns — `remove_node` drops every link
        // referencing a deleted node, so a port freed by a delete stops reporting
        // occupied. Deterministic `BTreeMap` iteration; O(links) per command, which
        // is fine for the headless harness / host producer (not a sim-hot path).
        self.from_ports = core.state.links_iter().map(|(from, _to)| from).collect();
    }

    /// Assign the next dense handle to `id` (both directions of the table).
    fn assign_handle(&mut self, id: NodeId) {
        let handle = self.next_handle;
        self.next_handle += 1;
        self.handle_to_node.insert(handle, id);
        self.node_to_handle.insert(id, handle);
    }

    /// The dense handle assigned to `node`, if it is live (the inverse of
    /// [`resolve`](GridLookup::resolve)). Lets a caller learn the handle a freshly
    /// placed node received.
    #[must_use]
    pub fn handle_of(&self, node: NodeId) -> Option<u64> {
        self.node_to_handle.get(&node).copied()
    }

    /// Pair this projection with the deterministic [`Core`] to obtain the
    /// [`GridLookup`] the command layer validates against. Occupancy + cells are read
    /// from `core.state` (single source, SPAT-01), and so is every kind byte (live node
    /// and live ports, phase 86); handles and from-ports come from
    /// this projection. The returned lens borrows both immutably — mirror of the
    /// host's transient `HostGridLookup` adapter (`input_apply.rs`).
    #[must_use]
    pub fn lookup<'a>(&'a self, core: &'a Core) -> GridViewLookup<'a> {
        GridViewLookup { view: self, core }
    }
}

/// The [`GridLookup`] implementor: a [`GridView`] projection paired with the
/// deterministic [`Core`]. Occupancy + cells delegate to `core.state` (the single
/// SPAT-01 authority), and so does kind capture (the live node and its live ports,
/// phase 86); handle resolution and the re-wire guard read the [`GridView`]
/// projection. Built transiently per validation via
/// [`GridView::lookup`] — the headless mirror of the host's `HostGridLookup`.
pub struct GridViewLookup<'a> {
    view: &'a GridView,
    core: &'a Core,
}

impl GridLookup for GridViewLookup<'_> {
    fn occupied_by(&self, cell: (i32, i32)) -> Option<NodeId> {
        // Single occupancy source: the core reverse-index (SPAT-01). The headless
        // GridSession re-projects after each apply, so there is never a pending edit
        // to OR in (unlike the host adapter) — this IS the parity baseline both
        // producers agree on for a folded grid.
        self.core.state.occupied(cell)
    }

    fn resolve(&self, handle: u64) -> Option<NodeId> {
        self.view.handle_to_node.get(&handle).copied()
    }

    fn cell_of(&self, node: NodeId) -> Option<(i32, i32)> {
        // Single cell source: core GridState (SPAT-01). Belts have no cell -> None.
        self.core.state.cell_of(node)
    }

    fn kind_of(&self, node: NodeId) -> Option<u8> {
        // Phase 86 (WORK-06, D-07): the LIVE node and its LIVE ports, the body the host
        // adapter and `is_handler` use, so a Factory that port edits turn into the
        // Handler shape reads HANDLER in both producers.
        self.core.state.node(node).map(|n| kind_byte(n, self.core.state.ports_of(node)))
    }

    fn link_exists(&self, from: (NodeId, PortId)) -> bool {
        self.view.from_ports.contains(&from)
    }

    fn wire_from_port(&self, from: (NodeId, PortId)) -> Option<NodeId> {
        // Single wire-topology source: the folded core nodes (SPAT-01). Deliberately
        // NOT projected into `from_ports`: that set is rebuilt from `links_iter`, and a
        // wire's link is keyed on the WIRE's port 0, so the source port never enters
        // it. Deterministic `BTreeMap` iteration; the headless session re-projects
        // after each apply, so there is never a pending edit to OR in.
        //
        // 72-08: this used to answer the BOOLEAN `wire_from_port_exists` directly with
        // `.any`. It now answers with the id and the boolean is the trait's default on
        // top of it, so the paired delete's "name the return leg" read and the
        // occupancy check's "is this port busy" read are ONE walk.
        self.core
            .state
            .node_ids()
            .find(|&id| matches!(self.core.state.node(id), Some(Node::Wire(w)) if w.from == from))
    }

    fn wire_touches_port(&self, at: (NodeId, PortId)) -> bool {
        // Same single wire-topology source as `wire_from_port` above - the folded core
        // nodes - and for the same reason: a wire's endpoints live INSIDE its `WireLink`
        // and only its forward `(wire, 0) -> to` edge is in `links`, so `from_ports`
        // cannot see either endpoint.
        self.core.state.node_ids().any(|id| {
            matches!(
                self.core.state.node(id),
                Some(Node::Wire(w)) if w.from == at || w.to == at
            )
        })
    }

    fn wire_endpoints(&self, wire: NodeId) -> Option<((NodeId, PortId), (NodeId, PortId))> {
        match self.core.state.node(wire) {
            Some(Node::Wire(w)) => Some((w.from, w.to)),
            _ => None,
        }
    }

    fn is_route(&self, node: NodeId) -> bool {
        // The LIVE node: see the trait docblock for why (a kind byte cached at mint
        // time, removed in phase 86, once made `kind_of` disagree across producers).
        self.core.state.node(node).is_some_and(is_route_shape)
    }

    fn is_handler(&self, node: NodeId) -> bool {
        // Node AND ports from the SAME core, keyed by the SAME id, handed to the ONE
        // shared predicate. The host adapter's body is the same two lines.
        self.core
            .state
            .node(node)
            .is_some_and(|n| is_handler_shape(n, self.core.state.ports_of(node)))
    }

    fn ports_of(&self, node: NodeId) -> Option<&[Port]> {
        // Single port source: core GridState (the frozen-at-Place ports — SPAT-01).
        self.core.state.ports_of(node)
    }

    fn footprint_of(&self, node: NodeId) -> Option<Footprint> {
        // A live node resolves to its recorded footprint, or the faithful 1×1-rot0
        // default (absent ⇒ 1×1); a non-live node yields None. Read from core.state
        // so the host adapter answers IDENTICALLY.
        self.core
            .state
            .node(node)
            .map(|_| self.core.state.footprint_of(node).unwrap_or(Footprint { w: 1, h: 1, rot: 0 }))
    }

    fn belt_geometry(&self, node: NodeId) -> Option<&[BeltTile]> {
        // Single belt source: the live core belt node's drawn geometry (SPAT-01). A
        // non-belt or a Wire-minted BELT (empty geometry) yields None -> not dockable.
        match self.core.state.node(node)? {
            Node::Belt(b) if !b.geometry.is_empty() => Some(&b.geometry),
            // A live `Node::Wire` RESOLVES as a carrier, with an EMPTY tile list
            // (74-06, LINK-05). It is the ONLY node kind that answers `Some` with
            // nothing in it, which is what lets the `Dock` arm name the wire-carrier
            // case explicitly instead of inferring it.
            //
            // WHY A WIRE HAS NO GEOMETRY TO GIVE, and why that is an answer rather
            // than a gap: a wire is not drawn on the grid. It carries two logical
            // endpoints and no cells, so there is no adjacency and no facing to judge
            // it by, and `acceptsWireTarget`'s own docblock on the frontend
            // (`ports.ts`) states the same thing in capitals: THERE IS NO SPATIAL
            // CHECK. `DrawWire` applies none either. The empty list is therefore the
            // honest answer to "what cells does this carrier occupy", not a stand-in
            // for one.
            //
            // A geometry-empty `Node::Belt` still answers `None` and is still refused
            // on the geometry check. The two cases are deliberately NOT collapsed: a
            // Wire-minted belt has a spatial identity it simply has not been given
            // yet, while a wire has none by construction.
            Node::Wire(_) => Some(&[]),
            _ => None,
        }
    }

    fn endpoint_path_owner(&self, path: &str, excluding: NodeId) -> Option<NodeId> {
        // Ascending `NodeId` (a `BTreeMap` walk), so the answer is a pure function of
        // the board rather than of iteration order.
        //
        // Paths compare by the Route key the host routes on (phase 91 review WR-A-04), so a
        // forged slashless `route-1` owns a typed `/route-1`: both answer at `/route-1`.
        self.core.state.node_ids().find(|&id| {
            id != excluding
                && matches!(
                    self.core.state.node(id),
                    Some(Node::Endpoint(ep)) if fabrico_core::edit::same_route_key(&ep.path, path)
                )
        })
    }

    fn links_touching(&self, node: NodeId) -> Vec<((NodeId, PortId), (NodeId, PortId))> {
        // The headless session folds each command before the next validates, so the folded
        // core IS the board the fold will see (see the trait docblock).
        self.core.state.links_iter().filter(|(from, to)| from.0 == node || to.0 == node).collect()
    }

    fn fold_belt_at(&self, cell: (i32, i32)) -> Option<(NodeId, &[BeltTile])> {
        // The folded core is the board the fold will see (see `links_touching`).
        let id = self.core.state.occupied(cell)?;
        match self.core.state.node(id)? {
            Node::Belt(b) if !b.geometry.is_empty() => Some((id, &b.geometry)),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fabrico_core::edit::{EDIT_SCHEMA_VERSION, EditOp, EditRecord};
    use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
    use fabrico_core::state::{Medium, Role, Side};

    /// Build a `GridView` + `Core` by folding `records` one-per-tick through the
    /// edit-log path (exactly how `GridSession` drives the view).
    fn folded(records: &[EditRecord]) -> (GridView, Core) {
        let mut core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: 7,
        });
        let mut view = GridView::new();
        for r in records {
            core.advance_edits(std::slice::from_ref(r), &[]);
            view.apply_tick(&core);
        }
        (view, core)
    }

    /// A RESOLVED multi-cell-aware Place record (the catalog-independent shape the
    /// session freezes).
    fn place(seq: u64, tick: u64, kind: u8, cell: (i32, i32), w: u16, h: u16, ports: Vec<Port>) -> EditRecord {
        EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: seq,
            tick,
            action: 0,
            op: EditOp::Place {
                kind,
                cell_x: cell.0,
                cell_y: cell.1,
                w,
                h,
                ports,
                rot: 0,
            },
        }
    }

    #[test]
    fn occupied_by_delegates_to_core_state() {
        // The headless producer's occupied_by IS core.state.occupied (the SPAT-01
        // single authority) — the parity baseline the host adapter must match.
        let (view, core) = folded(&[place(0, 0, machine_kind::SOURCE, (2, 3), 1, 1, vec![])]);
        let lk = view.lookup(&core);
        assert_eq!(lk.occupied_by((2, 3)), core.state.occupied((2, 3)));
        assert!(lk.occupied_by((2, 3)).is_some(), "the placed cell is occupied");
        assert_eq!(lk.occupied_by((9, 9)), None, "a free cell is unoccupied");
        // The default boolean `occupied` is derived from occupied_by.
        assert!(lk.occupied((2, 3)));
        assert!(!lk.occupied((9, 9)));
    }

    #[test]
    fn ports_and_footprint_read_frozen_multicell() {
        let ports = vec![
            Port { local_offset: (0, 0), side: Side::W, role: Role::In, medium: Medium::Mechanical },
            Port { local_offset: (1, 2), side: Side::E, role: Role::Out, medium: Medium::Mechanical },
        ];
        let (view, core) = folded(&[place(0, 0, machine_kind::ROUTER, (5, 5), 2, 3, ports.clone())]);
        let id = core.state.occupied((5, 5)).expect("the multi-cell anchor is occupied");
        let lk = view.lookup(&core);
        assert_eq!(lk.footprint_of(id), Some(Footprint { w: 2, h: 3, rot: 0 }));
        assert_eq!(lk.ports_of(id), Some(ports.as_slice()));
        // A NON-anchor body cell (local (1,2) -> world (6,7)) reads occupied by the
        // SAME node — the multi-cell occupancy claim, not just the anchor.
        assert_eq!(lk.occupied_by((6, 7)), Some(id));
    }

    #[test]
    fn footprint_defaults_1x1_and_portless_for_point_machine() {
        let (view, core) = folded(&[place(0, 0, machine_kind::SOURCE, (1, 1), 1, 1, vec![])]);
        let id = core.state.occupied((1, 1)).expect("the source anchor is occupied");
        let lk = view.lookup(&core);
        assert_eq!(
            lk.footprint_of(id),
            Some(Footprint { w: 1, h: 1, rot: 0 }),
            "a live node with no explicit footprint resolves to the faithful 1×1 default"
        );
        assert_eq!(lk.ports_of(id), None, "a point machine is port-less");
    }
}
