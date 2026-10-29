//! The fluent [`Scene`] builder — chainable authoring over [`GridSession`].
//!
//! `Scene` collapses the verbose "apply a `Place`, dig the minted `NodeId` out of
//! `core().last_tick.placed`, resolve its dense handle via `view().handle_of`" dance
//! (see `headless_build.rs::session_place`) into a single chainable call. It is a thin
//! wrapper that drives a [`GridSession`] and NOTHING ELSE — it never writes
//! `core.state` directly (CMD-05). Every mutation flows through `GridSession::apply` /
//! `pump` / `advance` / `move_machine`, so a Scene-authored grid is byte-identical to
//! the same grid built by hand AND replays from its own two logs.
//!
//! # Hash is primary (this phase's convention, T-13-HASH)
//! Terminal assertions LEAD with [`Scene::assert_hash`] — the one
//! [`oracle::tick_hash`](crate::oracle::tick_hash) digest. [`Scene::summary`] is a
//! NON-authoritative readability aid (counts + sorted faulted cells); it is never a
//! second equality check.
//!
//! # Belts take TIME, and how much is a per-belt knob (Pitfall 1, SLOT-03)
//! A belt moves an item one slot every `ticks_per_slot` ticks
//! (`fabrico_core::state::Belt::ticks_per_slot`, `62-CONTEXT.md` D-01), so a scenario
//! that expects an item to traverse a multi-tile belt before a terminal assert MUST
//! call [`Scene::advance`] enough times for the item to arrive.
//!
//! **This heading declared belts to move one slot per tick, and the paragraph under it
//! stated that rate as a fact of the model.** Both are retired: since Phase 62 a belt
//! carries its own interval and the old rate is just its `ticks_per_slot == 1` case. A
//! settle count written against the retired rate does not fail loudly when the interval
//! moves - it fails as SILENCE, with the item still mid-belt at the terminal assert -
//! which is why every settle budget in this crate is DERIVED from
//! `fabrico_core::belt_slots::DEFAULT_TICKS_PER_SLOT` rather than typed flat (plan
//! 62-03 raised them; the free tell of an under-run is a moved `items=` count in the
//! three insta snapshot summary lines).
//!
//! Idle `advance` ticks are UNLOGGED — a replay reaches them only by re-advancing the
//! same count (the determinism helper does).
//!
//! # The write-side axis is CLOSED (plan 63-08)
//! `Scene` maps ALL TWELVE `GridCommand` variants onto a builder method, one to one:
//! `Place`, `Delete`, `Rotate`, `DrawBelt`, `Dock`, `Undo`, `Redo`, `AddPort`,
//! `RemovePort`, `Configure`, `DrawWire`, `Unlink`. **The scenario harness can therefore
//! express every command the system has, by construction** — not because five phases'
//! success criteria were read as demanding each one. `scene_constructs_every_gridcommand_variant`
//! is the executable form of that claim, and the exhaustive `match` beside it makes a
//! thirteenth variant a compile error here.
//!
//! Six of the twelve landed in plan 63-08, and **that was the last wave in which any of
//! them could have been added**: `crates/fabrico-scenario` is entry 3 of
//! the core-freeze gate's `FROZEN_PATHS` and the freeze covers `src/` as surely
//! as `fixtures/`, so from Phase 64 a missing method is a scenario test that can never be
//! written, for any phase, ever. `remove_port` and `delete` are here for that closure
//! rather than for a requirement.
//!
//! # Minting returns, non-minting chains
//! One rule decides every signature: a command that MINTS a node returns its
//! [`Handle`] ([`place`](Scene::place), [`draw_belt`](Scene::draw_belt),
//! [`draw_wire`](Scene::draw_wire)); everything else returns `&mut Self` and chains.
//! Each method's doc says which and why, because "does this chain or return" is the first
//! thing an author needs and the answer should not require reading the body.

use std::collections::BTreeSet;
use std::fmt;

use fabrico_command::{GridLookup, GridSession};
use fabrico_core::command::Command;
use fabrico_core::core::Core;
use fabrico_core::event::Event;
use fabrico_core::ids::NodeId;
use fabrico_core::state::Node;
use fabrico_protocol::{BeltEnd, GridCommand, MachineConfig};

use crate::fixture::Scenario;
use crate::oracle;

/// A typed dense render handle — the `u64` a [`GridSession`]'s `GridView` assigns a
/// minted node (the value `view().handle_of(node_id)` returns). Newtyped so the
/// builder API speaks in `Handle`s, not bare integers, and `Wire`/`Dock`/`Rotate`
/// take the right operand by type.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Handle(pub u64);

/// A chainable authoring surface over a [`GridSession`] (the single Core mutator).
pub struct Scene {
    /// The wrapped session — the ONLY thing `Scene` mutates (CMD-05).
    session: GridSession,
    /// The genesis seed, kept so [`to_fixture`](Scene::to_fixture) can stamp the
    /// `Scenario` (the session does not expose its private seed).
    seed: u64,
}

impl Scene {
    /// A fresh empty scene seeded with `seed`.
    #[must_use]
    pub fn new(seed: u64) -> Self {
        Self {
            session: GridSession::new(seed),
            seed,
        }
    }

    /// Place a machine of `kind` (a [`machine_kind`](fabrico_protocol::machine_kind)
    /// byte) at cell `(x, y)` and return its typed [`Handle`]. This IS the
    /// `headless_build.rs::session_place` body: apply the `Place`, take the just-minted
    /// id from `last_tick.placed`, resolve its dense handle.
    ///
    /// # Panics
    /// Panics if the `Place` is rejected — a scenario authors a VALID grid, so an
    /// invalid placement is a test-authoring bug, surfaced loudly (not a typed error).
    pub fn place(&mut self, kind: u8, x: i32, y: i32) -> Handle {
        self.session
            .apply(GridCommand::Place {
                kind,
                cell_x: x,
                cell_y: y,
            })
            .expect("Scene::place: the Place must be accepted (author a valid grid)");
        self.last_minted_handle("place")
    }

    /// Draw a belt along the player-ordered, orthogonally-adjacent `cells` and return
    /// the minted belt's [`Handle`]. The command layer's pure `route()` resolves the
    /// raw cells into typed tiles (preview == commit).
    ///
    /// # Panics
    /// Panics if the belt is rejected (an authoring bug).
    pub fn draw_belt(&mut self, cells: &[(i32, i32)]) -> Handle {
        self.session
            .apply(GridCommand::DrawBelt {
                cells: cells.to_vec(),
            })
            .expect("Scene::draw_belt: the DrawBelt must be accepted");
        self.last_minted_handle("draw_belt")
    }

    /// Dock a belt `endpoint` to machine `node`'s `port` (a separate explicit action;
    /// the direction is implied by the endpoint + the port role). Chainable.
    ///
    /// # Panics
    /// Panics if the dock is rejected (an authoring bug).
    pub fn dock(&mut self, belt: Handle, endpoint: BeltEnd, node: Handle, port: u16) -> &mut Self {
        self.session
            .apply(GridCommand::Dock {
                belt: belt.0,
                endpoint,
                node: node.0,
                port,
            })
            .expect("Scene::dock: the Dock must be accepted");
        self
    }

    /// Rotate `node` one 90° quarter-turn (`ccw = true` ⇒ counter-clockwise). Chainable.
    ///
    /// # Panics
    /// Panics if the rotate is rejected (an authoring bug).
    pub fn rotate(&mut self, node: Handle, ccw: bool) -> &mut Self {
        self.session
            .apply(GridCommand::Rotate { node: node.0, ccw })
            .expect("Scene::rotate: the Rotate must be accepted");
        self
    }

    /// Move `node` to a new `kind`/cell — `delete + place` under ONE shared action
    /// (Phase-12 coalescing groundwork; NOT a new EditOp). Chainable.
    ///
    /// # Panics
    /// Panics if either leg is rejected (an authoring bug).
    pub fn move_(&mut self, node: Handle, kind: u8, x: i32, y: i32) -> &mut Self {
        self.session
            .move_machine(node.0, kind, x, y)
            .expect("Scene::move_: the move (delete+place) must be accepted");
        self
    }

    /// Undo the last still-live action group. Chainable.
    ///
    /// # Panics
    /// Panics if there is nothing to undo (an authoring bug).
    pub fn undo(&mut self) -> &mut Self {
        self.session
            .apply(GridCommand::Undo)
            .expect("Scene::undo: there must be an action to undo");
        self
    }

    /// Redo the next undone action group. Chainable.
    ///
    /// # Panics
    /// Panics if there is nothing to redo (an authoring bug).
    pub fn redo(&mut self) -> &mut Self {
        self.session
            .apply(GridCommand::Redo)
            .expect("Scene::redo: there must be an action to redo");
        self
    }

    /// Pump runtime `events` into the SECOND log — they are stamped at the current tick
    /// and folded EDITS-FIRST (the session owns ordering; a caller can never forge a
    /// tick). Pumping a slice in ONE call stamps every event at the SAME tick. Chainable.
    pub fn pump(&mut self, events: &[Event]) -> &mut Self {
        self.session.pump(events);
        self
    }

    /// Advance `ticks` IDLE ticks so multi-tile belts/sim settle (a belt moves one
    /// slot every `ticks_per_slot` ticks — Pitfall 1, SLOT-03; the module docblock
    /// records why a flat count taken against the retired one-slot-per-tick rate fails
    /// as silence). UNLOGGED: a replay must re-advance the same count. Chainable.
    pub fn advance(&mut self, ticks: u64) -> &mut Self {
        self.session.advance(ticks);
        self
    }

    /// Draw a request/response WIRE from `from`'s output port `from_port` to `to`'s input
    /// port `to_port` and return the minted wire's [`Handle`] (WIRE-02).
    ///
    /// Returns a `Handle` rather than chaining because a `DrawWire` MINTS — the same rule
    /// [`place`](Self::place) and [`draw_belt`](Self::draw_belt) follow, and the only rule
    /// that decides it: a minting command hands back the thing it minted, a non-minting
    /// one chains.
    ///
    /// Both ports must be declared `Medium::Electrical`, `Role::Out` on the `from` side
    /// and `Role::In` on the `to` side; the command layer is the one gate and refuses
    /// anything else. This method adds NO validation of its own.
    ///
    /// Landed in Phase 63 because `crates/fabrico-scenario` is entry 3 of
    /// the core-freeze gate's `FROZEN_PATHS` and closes at this phase's exit,
    /// so no later phase could add it.
    ///
    /// # Panics
    /// Panics if the wire is rejected (an authoring bug) — a silently refused command
    /// would let an unbuilt board pass for a built one.
    pub fn draw_wire(
        &mut self,
        from: Handle,
        from_port: u16,
        to: Handle,
        to_port: u16,
    ) -> Handle {
        self.session
            .apply(GridCommand::DrawWire {
                from_node: from.0,
                from_port,
                to_node: to.0,
                to_port,
            })
            .expect("Scene::draw_wire: the DrawWire must be accepted");
        self.last_minted_handle("draw_wire")
    }

    /// Remove ONE directed dock link — the explicit DISCONNECT verb (CONNECT-01).
    /// Chainable, because an `Unlink` mints nothing.
    ///
    /// The field set is [`dock`](Self::dock)'s exactly, and deliberately: an unlink and
    /// the dock that created it name the SAME link from the SAME side, so a different
    /// field set would make the two impossible to pair. `port` is the machine port's
    /// SPATIAL catalog index, translated into the link keyspace by the command layer —
    /// the SAME translation `Dock` uses, never a second copy of it, because a
    /// `GridCommand` names a port by catalog index while a `links` entry is keyed in the
    /// routing keyspace and the two collide numerically on a Router.
    ///
    /// Landed in Phase 63 for the frozen-crate reason on [`draw_wire`](Self::draw_wire).
    ///
    /// # Panics
    /// Panics if the unlink is rejected (an authoring bug).
    pub fn unlink(
        &mut self,
        belt: Handle,
        endpoint: BeltEnd,
        node: Handle,
        port: u16,
    ) -> &mut Self {
        self.session
            .apply(GridCommand::Unlink {
                belt: belt.0,
                endpoint,
                node: node.0,
                port,
            })
            .expect("Scene::unlink: the Unlink must be accepted");
        self
    }

    /// Configure machine `node` (ROUTE-03 for a router's rules, BELT-02 for a belt's
    /// interval, CFG-01/CFG-02 for the other three). Chainable, because a `Configure`
    /// mints nothing.
    ///
    /// `config` is the PROTOCOL [`MachineConfig`](fabrico_protocol::MachineConfig), not
    /// `fabrico_core::edit::MachineConfig`: `Scene` drives `GridCommand`s through the
    /// session seam and `GridCommand::Configure` carries the protocol type. The command
    /// validator converts it into the byte-identical core shape.
    ///
    /// # What its absence meant, stated plainly
    /// Until this method a grep for `Configure` across the WHOLE of
    /// `crates/fabrico-scenario` returned NOTHING. The harness could not express an
    /// `EditOp::Configure` for ANY machine kind, so no scenario fixture has ever covered
    /// machine configuration at all. That is not a v8.0 gap: it is a gap the corpus has
    /// always had, and Phase 63 is the only remaining opportunity to close it, because
    /// this crate is frozen from Phase 64 onward.
    ///
    /// All five variants are reachable through this one method, Belt and Router included
    /// — which is why this wave could not run before plan 63-04 landed the protocol
    /// mirror of those two.
    ///
    /// # Panics
    /// Panics if the configure is rejected (an authoring bug).
    pub fn configure(&mut self, node: Handle, config: MachineConfig) -> &mut Self {
        self.session
            .apply(GridCommand::Configure {
                node: node.0,
                config,
            })
            .expect("Scene::configure: the Configure must be accepted");
        self
    }

    /// Add a design-time port to placed machine `node` (PORT-06/07). Chainable, because
    /// an `AddPort` mints no NODE.
    ///
    /// The four wire bytes ride through verbatim, `medium` included — `role` In=0/Out=1/
    /// Fault=2, `side` N=0/E=1/S=2/W=3, `medium` Mechanical=0/Electrical=1. Carrying the
    /// medium is the whole reason this method exists: plan 63-07 decided the far end of a
    /// hand-drawn wire is an electrical `Role::In` added with exactly this command
    /// (WIRE-03), so a method that dropped or defaulted the byte would make both endpoint
    /// scenes unauthorable. The fold RE-SEATS `local_offset` from the port's list
    /// position, which is why no offset is carried.
    ///
    /// Landed in Phase 63 for the frozen-crate reason on [`draw_wire`](Self::draw_wire).
    ///
    /// # Panics
    /// Panics if the add is rejected (an authoring bug).
    pub fn add_port(&mut self, node: Handle, role: u8, side: u8, medium: u8) -> &mut Self {
        self.session
            .apply(GridCommand::AddPort {
                node: node.0,
                role,
                side,
                medium,
            })
            .expect("Scene::add_port: the AddPort must be accepted");
        self
    }

    /// Remove the design-time port at `index` from placed machine `node` (PORT-07).
    /// Chainable.
    ///
    /// No Phase 64-68 success criterion demands this as those criteria are currently
    /// read. It is here for the CLOSURE (see the module docblock) rather than for a
    /// requirement: "as currently read" is the reasoning that failed on the Router arity,
    /// the scenario corpus and the Endpoint fold arm, and the cost is asymmetric — an
    /// unnecessary method costs one unused method, an absent one is permanently
    /// unfixable, because this crate is frozen from Phase 64.
    ///
    /// # Panics
    /// Panics if the removal is rejected (an authoring bug).
    pub fn remove_port(&mut self, node: Handle, index: u16) -> &mut Self {
        self.session
            .apply(GridCommand::RemovePort {
                node: node.0,
                index,
            })
            .expect("Scene::remove_port: the RemovePort must be accepted");
        self
    }

    /// Delete `node` — a PLAIN delete, one `GridCommand::Delete` and therefore one edit
    /// record. Chainable.
    ///
    /// NOT a [`move_`](Self::move_)-style compound. Deleting was reachable from a scene
    /// only INSIDE `move_`, which issues a delete and a place under ONE shared action, so
    /// no scene could express a plain delete at all. Here for the same closure argument
    /// as [`remove_port`](Self::remove_port).
    ///
    /// # Panics
    /// Panics if the delete is rejected (an authoring bug).
    pub fn delete(&mut self, node: Handle) -> &mut Self {
        self.session
            .apply(GridCommand::Delete { node: node.0 })
            .expect("Scene::delete: the Delete must be accepted");
        self
    }

    /// Resolve a [`Handle`] to its live [`NodeId`] — needed to author `pump` events
    /// (which target nodes by `NodeId`, not dense handle). `None` if the handle is not
    /// a live node.
    #[must_use]
    pub fn node_id(&self, handle: Handle) -> Option<NodeId> {
        self.session
            .view()
            .lookup(self.session.core())
            .resolve(handle.0)
    }

    // ───────────────────────── terminal / read accessors ─────────────────────────

    /// Take every effect the scene has emitted SINCE THE LAST DRAIN, and clear the
    /// buffer (WIRE-04).
    ///
    /// # It accumulates, and that is the point
    /// [`advance`](Self::advance) runs a whole settle budget in ONE call and the session
    /// folds one tick per iteration, so an accessor reporting only the LAST fold would
    /// return the final IDLE tick's effects — which are empty. A reply emitted at tick N
    /// is still returned here after `advance(SETTLE)`, which is the property this method
    /// exists for and the one a per-fold accessor fails. Draining CLEARS: a second call
    /// with no intervening fold returns nothing.
    ///
    /// # It moves no fixture byte
    /// A read of NON-SERIALIZED in-memory state. Nothing [`to_fixture`](Self::to_fixture)
    /// writes and nothing [`hash`](Self::hash) digests reads it, so a scene that drains
    /// and a scene that does not produce identical bytes (T-63-63, measured against the
    /// golden corpus rather than argued).
    ///
    /// Before this method `GridSession::pump` and `::advance` DISCARDED the `Vec<Command>`
    /// each fold returns and `Scene` exposed no way to see them, so no scenario test could
    /// assert that anything ever left the grid. Landed in Phase 63 because this crate is
    /// frozen from Phase 64 onward.
    pub fn drain_effects(&mut self) -> Vec<Command> {
        self.session.drain_effects()
    }

    /// HASH-PRIMARY terminal assertion: the scene's [`tick_hash`](crate::oracle::tick_hash)
    /// equals `expected`. The single digest path (T-13-HASH).
    ///
    /// # Panics
    /// Panics with a diff if the hash differs.
    pub fn assert_hash(&self, expected: &str) {
        assert_eq!(
            self.hash(),
            expected,
            "Scene::assert_hash: state hash mismatch (HASH PRIMARY, T-13-HASH)"
        );
    }

    /// The scene's current [`tick_hash`](crate::oracle::tick_hash) (valid at a clean
    /// tick boundary).
    #[must_use]
    pub fn hash(&self) -> String {
        oracle::tick_hash(self.session.core())
    }

    /// An id-free, run-stable [`StateSummary`] (counts + sorted faulted cells). A
    /// readability aid — never a second equality check (the hash is primary).
    #[must_use]
    pub fn summary(&self) -> StateSummary {
        StateSummary::of(self.session.core())
    }

    /// Bundle the scene's `(seed, edit_log, event_log)` into a replayable [`Scenario`].
    /// `GridSession::replay_two_logs` reproduces the live core byte-identically (modulo
    /// any UNLOGGED trailing idle `advance`, which a replay re-applies separately).
    #[must_use]
    pub fn to_fixture(&self) -> Scenario {
        Scenario::new(
            self.seed,
            self.session.edit_log().to_vec(),
            self.session.event_log().to_vec(),
        )
    }

    /// The underlying deterministic [`Core`] (read-only) — for direct state assertions.
    #[must_use]
    pub fn core(&self) -> &Core {
        self.session.core()
    }

    /// The wrapped [`GridSession`] (read-only) — for tests needing the view/logs.
    #[must_use]
    pub fn session(&self) -> &GridSession {
        &self.session
    }

    /// The dense handle of the node minted by the most recent accepted command — the
    /// shared tail of [`place`](Self::place) / [`draw_belt`](Self::draw_belt).
    fn last_minted_handle(&self, who: &str) -> Handle {
        let id = *self
            .session
            .core()
            .last_tick
            .placed
            .last()
            .unwrap_or_else(|| panic!("Scene::{who}: a node was minted this tick"));
        Handle(
            self.session
                .view()
                .handle_of(id)
                .unwrap_or_else(|| panic!("Scene::{who}: the minted node got a dense handle")),
        )
    }
}

/// An id-free, insta-stable digest of the grid's SHAPE: plain counts plus a SORTED set
/// of faulted CELLS. It holds NO raw [`NodeId`]s / handles and NO `HashSet` (Pitfall
/// 3): undo/redo re-mints node ids, so a summary keyed on ids would churn across runs
/// while the snapshot hash stays stable — this summary deliberately exposes only
/// position- and count-stable facts, so its [`Display`](fmt::Display) string is
/// identical across every run of the same scenario.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateSummary {
    /// Total live nodes (machines AND `Wire`-minted belts) — `state.node_count()`.
    pub nodes: usize,
    /// The belt subset of `nodes` (every `Node::Belt`).
    pub belts: usize,
    /// Resident items: occupied belt slots PLUS items queued in source pending FIFOs.
    /// A non-authoritative readability count (the hash is the authority).
    pub items: usize,
    /// The cells of nodes that faulted on the last folded tick (id-free, SORTED).
    /// Belts carry no cell, so a faulted belt contributes nothing here.
    pub faulted_cells: BTreeSet<(i32, i32)>,
}

impl StateSummary {
    /// Derive the summary from a [`Core`] at a clean tick boundary.
    ///
    /// Public so the data-driven golden test (`tests/golden_hashes.rs`) can render the
    /// secondary id-free summary from a `GridSession::replay_two_logs` core — the replay
    /// yields a bare [`Core`], not a [`Scene`], so it needs this `Core`-level constructor
    /// rather than [`Scene::summary`].
    #[must_use]
    pub fn of(core: &Core) -> Self {
        let state = &core.state;
        let nodes = state.node_count();
        let mut belts = 0usize;
        let mut items = 0usize;
        for id in state.node_ids() {
            match state.node(id) {
                Some(Node::Belt(belt)) => {
                    belts += 1;
                    items += belt.slots.iter().filter(|s| s.is_some()).count();
                }
                Some(Node::Source(src)) => items += src.pending.len(),
                _ => {}
            }
        }
        // Map the last tick's faulted node ids to their CELLS (id-free); drop any
        // cell-less node (e.g. a belt). BTreeSet ⇒ sorted, deterministic iteration.
        let faulted_cells: BTreeSet<(i32, i32)> = core
            .last_tick
            .faulted
            .iter()
            .filter_map(|&id| state.cell_of(id))
            .collect();
        Self {
            nodes,
            belts,
            items,
            faulted_cells,
        }
    }
}

impl fmt::Display for StateSummary {
    /// A stable one-line rendering: `nodes=N belts=B items=I faulted=[(x,y),...]`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "nodes={} belts={} items={} faulted=[",
            self.nodes, self.belts, self.items
        )?;
        for (i, (x, y)) in self.faulted_cells.iter().enumerate() {
            if i > 0 {
                write!(f, ",")?;
            }
            write!(f, "({x},{y})")?;
        }
        write!(f, "]")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fabrico_core::belt_slots::DEFAULT_TICKS_PER_SLOT;
    use fabrico_core::command::Effect;
    use fabrico_core::edit::EditOp;
    use fabrico_core::event::{Event, EventPayload, SCHEMA_VERSION};
    use fabrico_core::ids::Item;
    use fabrico_core::snapshot::snapshot;
    use fabrico_core::state::{Medium, Port, Role};
    use fabrico_protocol::machine_kind::{ENDPOINT, FACTORY, ROUTER, SINK, SOURCE};
    use fabrico_protocol::{
        MachineConfig, RouteKey, SinkTemplate, SourceTrigger, port_medium, port_role,
    };

    const SEED: u64 = 0xFAB_C0DE;

    /// The live port list of `handle`'s node — read straight off the folded core.
    ///
    /// Deliberately a TEST-LOCAL helper and NOT a `Scene` method. `Scene::core()` already
    /// exposes the whole read side, so a later phase that wants this can write it in its
    /// OWN crate; it carries none of the this-phase-or-never asymmetry the six command
    /// mappings do, and a frozen crate should not carry a public method nothing forced.
    fn ports_of(scene: &Scene, handle: Handle) -> Vec<Port> {
        let id = scene.node_id(handle).expect("the handle resolves to a live node");
        scene
            .core()
            .state
            .ports_of(id)
            .expect("the node has a port list")
            .to_vec()
    }

    /// The 0-based catalog index of `handle`'s first `role`/`medium` port. Test-local for
    /// the same reason as [`ports_of`].
    fn port_index_of(scene: &Scene, handle: Handle, role: Role, medium: Medium) -> u16 {
        let index = ports_of(scene, handle)
            .iter()
            .position(|p| p.role == role && p.medium == medium)
            .expect("the node declares a port of that role and medium");
        u16::try_from(index).expect("a catalog index fits in u16")
    }

    /// Apply a Place via the verbose dance and return the minted dense handle (the
    /// body `Scene::place` collapses) — for the ergonomics-equivalence test.
    fn session_place(session: &mut GridSession, kind: u8, x: i32, y: i32) -> u64 {
        session
            .apply(GridCommand::Place {
                kind,
                cell_x: x,
                cell_y: y,
            })
            .expect("place accepted");
        let id = *session.core().last_tick.placed.last().expect("node minted");
        session.view().handle_of(id).expect("handle")
    }

    /// Draw + dock a straight belt from `src`'s Out (port 0) to `sink`'s In (port 0) —
    /// the post-Wire (17-02) replacement for the removed `Scene::wire` convenience.
    /// For the fixed `src`@(0,0) / `sink`@(3,0) layout these tests use: the source Out
    /// faces E (facing cell (1,0)); the sink In faces W (facing cell (2,0)); the 2-tile
    /// belt (1,0)->(2,0) OFFLOAD-docks its Tail to `src` and LOAD-docks its Head to `sink`.
    fn wire_src_sink(scene: &mut Scene, src: Handle, sink: Handle) {
        let belt = scene.draw_belt(&[(1, 0), (2, 0)]);
        scene.dock(belt, BeltEnd::Tail, src, 0);
        scene.dock(belt, BeltEnd::Head, sink, 0);
    }

    #[test]
    fn place_returns_the_view_dense_handle() {
        let mut scene = Scene::new(SEED);
        let h = scene.place(SOURCE, 0, 0);
        let id = *scene.core().last_tick.placed.last().expect("minted");
        assert_eq!(
            h.0,
            scene.session().view().handle_of(id).expect("handle"),
            "place() returns exactly view().handle_of(minted_id)"
        );
        assert_eq!(h.0, 0, "the first minted node gets dense handle 0");
    }

    #[test]
    fn scene_hash_equals_verbose_session_hash() {
        // Scene-built sub-graph.
        let mut scene = Scene::new(SEED);
        let src = scene.place(SOURCE, 0, 0);
        let sink = scene.place(SINK, 3, 0);
        wire_src_sink(&mut scene, src, sink);
        let scene_hash = scene.hash();

        // The SAME graph via the verbose GridSession dance.
        let mut session = GridSession::new(SEED);
        let s = session_place(&mut session, SOURCE, 0, 0);
        let k = session_place(&mut session, SINK, 3, 0);
        // The verbose equivalent of `wire_src_sink`: DrawBelt then dock both ends.
        session
            .apply(GridCommand::DrawBelt { cells: vec![(1, 0), (2, 0)] })
            .expect("drawbelt accepted");
        let belt_id = *session.core().last_tick.placed.last().expect("belt minted");
        let belt_h = session.view().handle_of(belt_id).expect("belt handle");
        session
            .apply(GridCommand::Dock { belt: belt_h, endpoint: BeltEnd::Tail, node: s, port: 0 })
            .expect("tail dock accepted");
        session
            .apply(GridCommand::Dock { belt: belt_h, endpoint: BeltEnd::Head, node: k, port: 0 })
            .expect("head dock accepted");

        assert_eq!(
            scene_hash,
            oracle::tick_hash(session.core()),
            "Scene ergonomics are equivalent to the verbose session (same hash)"
        );
    }

    #[test]
    fn summary_is_id_free_and_run_stable() {
        let build = || {
            let mut scene = Scene::new(SEED);
            let src = scene.place(SOURCE, 0, 0);
            let sink = scene.place(SINK, 3, 0);
            wire_src_sink(&mut scene, src, sink);
            scene.summary()
        };
        let a = build();
        let b = build();
        assert_eq!(a, b, "summary is identical across two runs (no raw ids)");
        assert_eq!(a.to_string(), b.to_string(), "string output is run-stable");
        assert_eq!(a.nodes, 3, "source + sink + the drawn belt");
        assert_eq!(a.belts, 1, "the DrawBelt minted exactly one belt");
        assert!(a.faulted_cells.is_empty(), "a clean build faults nothing");
    }

    #[test]
    fn to_fixture_replays_byte_identical() {
        let mut scene = Scene::new(SEED);
        let src = scene.place(SOURCE, 0, 0);
        let sink = scene.place(SINK, 3, 0);
        wire_src_sink(&mut scene, src, sink);
        // Pump a runtime event so the SECOND log is exercised too.
        let src_id = scene.node_id(src).expect("source resolves to a NodeId");
        scene.pump(&[Event {
            schema_version: SCHEMA_VERSION,
            partition: 0,
            sequence: 0,
            tick: 0,
            payload: EventPayload::ManualInject {
                target: src_id,
                port: 0,
                item: Item(vec![1]),
            },
        }]);

        let fx = scene.to_fixture();
        let replay = GridSession::replay_two_logs(fx.seed, &fx.edit_log, &fx.event_log);
        assert_eq!(
            snapshot(replay.core()),
            snapshot(scene.core()),
            "replay_two_logs reproduces the Scene-authored core byte-identically"
        );
    }

    // ───────────────── the write-side axis, and the effects it produces ─────────────────
    //
    // Everything below covers the six command mappings and the effect accessor added in
    // plan 63-08 — the wave that closed `Scene` over `GridCommand`. `crates/fabrico-scenario`
    // is entry 3 of `FROZEN_PATHS`, so this is the last wave in which any of them could
    // have been written.

    /// The TWELVE-OF-TWELVE closure, as an executable loop rather than a claim.
    ///
    /// Every `GridCommand` variant must be CONSTRUCTED by a `Scene` builder method. The
    /// check reads this file's own source and searches only the half ABOVE `#[cfg(test)]`,
    /// because a `GridCommand::X` written inside this test module would satisfy a
    /// whole-file grep without any builder method existing — the exact vacuous pass the
    /// criterion exists to prevent.
    ///
    /// The companion `match` below is the compile-time half: a THIRTEENTH variant appended
    /// to `GridCommand` stops this file compiling, so the name list cannot silently go
    /// stale.
    #[test]
    fn scene_constructs_every_gridcommand_variant() {
        const VARIANTS: [&str; 12] = [
            "Place",
            "Delete",
            "Rotate",
            "DrawBelt",
            "Dock",
            "Undo",
            "Redo",
            "AddPort",
            "RemovePort",
            "Configure",
            "DrawWire",
            "Unlink",
        ];
        let source = include_str!("scene.rs");
        let builders = source
            .split("#[cfg(test)]")
            .next()
            .expect("the file has a non-test half");
        let missing: Vec<&str> = VARIANTS
            .iter()
            .copied()
            .filter(|v| !builders.contains(&format!("GridCommand::{v}")))
            .collect();
        assert!(
            missing.is_empty(),
            "the write-side axis is NOT closed: no Scene builder constructs {missing:?}",
        );
    }

    /// The compile-time half of the closure above: this `match` is exhaustive over
    /// `GridCommand`, so appending a thirteenth variant is a COMPILE ERROR here and the
    /// twelve-name list cannot drift away from the enum it describes.
    #[test]
    fn the_variant_list_is_exhaustive_over_gridcommand() {
        fn name(cmd: &GridCommand) -> &'static str {
            match cmd {
                GridCommand::Place { .. } => "Place",
                GridCommand::Delete { .. } => "Delete",
                GridCommand::Rotate { .. } => "Rotate",
                GridCommand::DrawBelt { .. } => "DrawBelt",
                GridCommand::Dock { .. } => "Dock",
                GridCommand::Undo => "Undo",
                GridCommand::Redo => "Redo",
                GridCommand::AddPort { .. } => "AddPort",
                GridCommand::RemovePort { .. } => "RemovePort",
                GridCommand::Configure { .. } => "Configure",
                GridCommand::DrawWire { .. } => "DrawWire",
                GridCommand::Unlink { .. } => "Unlink",
            }
        }
        assert_eq!(name(&GridCommand::Undo), "Undo");
        assert_eq!(name(&GridCommand::Redo), "Redo");
    }

    #[test]
    fn draw_wire_returns_the_minted_wires_handle() {
        // The endpoint's electrical Out to an AddPort-ed electrical In on a factory —
        // the wire destination plan 63-07 decided, authored entirely through `Scene`.
        let mut scene = Scene::new(SEED);
        let ep = scene.place(ENDPOINT, 0, 0);
        let factory = scene.place(FACTORY, 5, 0);
        scene.add_port(factory, port_role::IN, /*W*/ 3, port_medium::ELECTRICAL);

        let from_port = port_index_of(&scene, ep, Role::Out, Medium::Electrical);
        let to_port = port_index_of(&scene, factory, Role::In, Medium::Electrical);
        let wire = scene.draw_wire(ep, from_port, factory, to_port);

        let wire_id = scene.node_id(wire).expect("the wire handle resolves");
        assert!(
            matches!(scene.core().state.node(wire_id), Some(Node::Wire(_))),
            "draw_wire returns the handle of the MINTED Node::Wire, not of either endpoint",
        );
        let factory_id = scene.node_id(factory).expect("the factory resolves");
        assert_eq!(
            scene.core().state.link_target((wire_id, 0)),
            Some((factory_id, to_port)),
            "the wire's forward link reaches the AddPort-ed electrical In",
        );
    }

    #[test]
    fn add_port_carries_its_medium_byte_verbatim() {
        // `medium` is the whole reason `Scene::add_port` exists: an electrical port is
        // what a hand-drawn wire terminates on. A method that dropped or defaulted the
        // byte would author a board that cannot be wired.
        let mut scene = Scene::new(SEED);
        let factory = scene.place(FACTORY, 0, 0);
        let before = ports_of(&scene, factory).len();
        scene.add_port(factory, port_role::IN, /*W*/ 3, port_medium::ELECTRICAL);

        let ports = ports_of(&scene, factory);
        assert_eq!(ports.len(), before + 1, "exactly one port was added");
        let added = ports.last().expect("the added port");
        assert_eq!(
            added.medium,
            Medium::Electrical,
            "the medium byte reached the folded Port unaltered",
        );
        assert_eq!(added.role, Role::In, "the role byte reached it too");
    }

    #[test]
    fn remove_port_removes_the_named_index() {
        let mut scene = Scene::new(SEED);
        let factory = scene.place(FACTORY, 0, 0);
        scene.add_port(factory, port_role::IN, 3, port_medium::ELECTRICAL);
        let grown = ports_of(&scene, factory).len();

        let index = u16::try_from(grown - 1).expect("index fits");
        scene.remove_port(factory, index);
        assert_eq!(
            ports_of(&scene, factory).len(),
            grown - 1,
            "remove_port removed exactly the named index",
        );
        assert!(
            ports_of(&scene, factory)
                .iter()
                .all(|p| p.medium == Medium::Mechanical),
            "the electrical port is the one that went",
        );
    }

    #[test]
    fn delete_is_one_record_not_a_move_style_pair() {
        // `move_` is delete + place under ONE shared action, which is why a scene could
        // not express a plain delete before this method. The proof is the log: one
        // record, and it is a Delete.
        let mut scene = Scene::new(SEED);
        let src = scene.place(SOURCE, 0, 0);
        let before = scene.session().edit_log().len();
        scene.delete(src);

        let added = &scene.session().edit_log()[before..];
        assert_eq!(
            added.len(),
            1,
            "delete issues exactly ONE edit record (a move-style pair would be two)",
        );
        assert!(
            matches!(added[0].op, EditOp::Delete { .. }),
            "and that record is a Delete",
        );
        assert!(
            scene.node_id(src).is_none(),
            "the deleted node has no live handle",
        );
    }

    #[test]
    fn unlink_removes_the_dock_link_a_dock_created() {
        let mut scene = Scene::new(SEED);
        let src = scene.place(SOURCE, 0, 0);
        let sink = scene.place(SINK, 3, 0);
        let belt = scene.draw_belt(&[(1, 0), (2, 0)]);
        scene.dock(belt, BeltEnd::Tail, src, 0);
        scene.dock(belt, BeltEnd::Head, sink, 0);
        let src_id = scene.node_id(src).expect("source resolves");
        let belt_id = scene.node_id(belt).expect("belt resolves");
        assert!(
            scene.core().state.link_target((src_id, 0)).is_some(),
            "the Tail dock wrote a machine-keyed link",
        );

        scene.unlink(belt, BeltEnd::Tail, src, 0);
        assert!(
            scene.core().state.link_target((src_id, 0)).is_none(),
            "unlink removed exactly the link the dock created",
        );
        assert!(
            scene.core().state.link_target((belt_id, 0)).is_some(),
            "and left the Head dock's belt-keyed link alone",
        );
    }

    #[test]
    fn configure_reaches_the_belt_variant() {
        // Until plan 63-08 a grep for `Configure` across the WHOLE of
        // crates/fabrico-scenario returned nothing: no scenario fixture has ever covered
        // machine configuration, for any machine kind. Belt is one of the two variants
        // plan 63-04 appended.
        let mut scene = Scene::new(SEED);
        let belt = scene.draw_belt(&[(0, 0), (1, 0)]);
        scene.configure(belt, MachineConfig::Belt { ticks_per_slot: 7 });

        let belt_id = scene.node_id(belt).expect("belt resolves");
        let Some(Node::Belt(b)) = scene.core().state.node(belt_id) else {
            panic!("the node is a belt");
        };
        assert_eq!(
            b.ticks_per_slot.get(),
            7,
            "the Belt config reached the folded belt",
        );
    }

    #[test]
    fn configure_reaches_the_router_variant() {
        let mut scene = Scene::new(SEED);
        let router = scene.place(ROUTER, 0, 0);
        scene.configure(
            router,
            MachineConfig::Router {
                routes: vec![(
                    RouteKey {
                        offset: 0,
                        expect: vec![0xAA],
                    },
                    1,
                )],
                default: Some(0),
            },
        );

        let router_id = scene.node_id(router).expect("router resolves");
        let Some(Node::Router(r)) = scene.core().state.node(router_id) else {
            panic!("the node is a router");
        };
        assert_eq!(r.routes.len(), 1, "the routing table reached the fold");
        assert_eq!(r.default, Some(0), "and so did the default port");
    }

    #[test]
    fn configure_expresses_all_five_variants_through_this_one_method() {
        // "All five" is asserted rather than claimed. Each variant is applied to a machine
        // of its own kind and the resulting edit record is read back off the log, so a
        // silently refused Configure cannot pass for one that ran.
        let mut scene = Scene::new(SEED);
        let factory = scene.place(FACTORY, 0, 0);
        let source = scene.place(SOURCE, 6, 0);
        let sink = scene.place(SINK, 9, 0);
        let router = scene.place(ROUTER, 12, 0);
        let belt = scene.draw_belt(&[(0, 6), (1, 6)]);
        let before = scene.session().edit_log().len();

        scene.configure(
            factory,
            MachineConfig::Factory {
                source: "export default (i) => i;".to_owned(),
            },
        );
        scene.configure(
            source,
            MachineConfig::Source {
                trigger: SourceTrigger::Timer { interval_ticks: 4 },
            },
        );
        scene.configure(
            sink,
            MachineConfig::Sink {
                target: SinkTemplate::Debug,
            },
        );
        scene.configure(belt, MachineConfig::Belt { ticks_per_slot: 3 });
        scene.configure(
            router,
            MachineConfig::Router {
                routes: Vec::new(),
                default: None,
            },
        );

        let added = &scene.session().edit_log()[before..];
        assert_eq!(added.len(), 5, "five Configures, five records");
        assert!(
            added
                .iter()
                .all(|r| matches!(r.op, EditOp::Configure { .. })),
            "every one of them is an EditOp::Configure - the op no scenario fixture \
             had ever carried before this wave",
        );
    }

    #[test]
    fn drain_effects_accumulates_across_a_whole_settle() {
        // THE load-bearing test. `Scene::advance(SETTLE)` runs the entire settle budget
        // in ONE call and `GridSession::advance` loops `advance_edits` once per tick, so
        // a LAST-FOLD accessor returns the final IDLE tick's effects, which are empty.
        // The item below reaches the sink early in the settle and the sink emits its
        // Debug effect THERE; every later tick emits nothing. This test therefore FAILS
        // against a per-fold implementation and passes only against an accumulating one.
        const SETTLE: u64 = 64 * DEFAULT_TICKS_PER_SLOT.get() as u64;

        let mut scene = Scene::new(SEED);
        let src = scene.place(SOURCE, 0, 0);
        let sink = scene.place(SINK, 5, 0);
        let belt = scene.draw_belt(&[(1, 0), (2, 0), (3, 0), (4, 0)]);
        scene.dock(belt, BeltEnd::Tail, src, 0);
        scene.dock(belt, BeltEnd::Head, sink, 0);

        let src_id = scene.node_id(src).expect("source resolves");
        scene.pump(&[Event {
            schema_version: SCHEMA_VERSION,
            partition: 0,
            sequence: 0,
            tick: 0,
            payload: EventPayload::ManualInject {
                target: src_id,
                port: 0,
                item: Item(vec![0xA5]),
            },
        }]);
        scene.advance(SETTLE);

        let effects = scene.drain_effects();
        assert!(
            effects.iter().any(|c| c.effect
                == Effect::Debug {
                    message: vec![0xA5]
                }),
            "the effect emitted mid-settle is still observable after the settle \
             (a last-fold accessor returns the empty final idle tick): got {effects:?}",
        );
    }

    #[test]
    fn drain_effects_clears_on_read() {
        const SETTLE: u64 = 64 * DEFAULT_TICKS_PER_SLOT.get() as u64;

        let mut scene = Scene::new(SEED);
        let src = scene.place(SOURCE, 0, 0);
        let sink = scene.place(SINK, 5, 0);
        let belt = scene.draw_belt(&[(1, 0), (2, 0), (3, 0), (4, 0)]);
        scene.dock(belt, BeltEnd::Tail, src, 0);
        scene.dock(belt, BeltEnd::Head, sink, 0);
        let src_id = scene.node_id(src).expect("source resolves");
        scene.pump(&[Event {
            schema_version: SCHEMA_VERSION,
            partition: 0,
            sequence: 0,
            tick: 0,
            payload: EventPayload::ManualInject {
                target: src_id,
                port: 0,
                item: Item(vec![0xA5]),
            },
        }]);
        scene.advance(SETTLE);

        assert!(
            !scene.drain_effects().is_empty(),
            "the first drain returns the settle's effects",
        );
        assert!(
            scene.drain_effects().is_empty(),
            "a second drain with no intervening fold returns nothing: draining CLEARS",
        );
    }

    #[test]
    fn the_effect_buffer_moves_no_fixture_byte() {
        // T-63-63: the buffer is in-memory only. A scene that drains and a scene that
        // never drains must produce the SAME `to_fixture` bytes and the SAME hash, which
        // is the crate-local half of the claim the corpus measurement proves globally.
        let build = |drain: bool| {
            let mut scene = Scene::new(SEED);
            let src = scene.place(SOURCE, 0, 0);
            let sink = scene.place(SINK, 5, 0);
            let belt = scene.draw_belt(&[(1, 0), (2, 0), (3, 0), (4, 0)]);
            scene.dock(belt, BeltEnd::Tail, src, 0);
            scene.dock(belt, BeltEnd::Head, sink, 0);
            let src_id = scene.node_id(src).expect("source resolves");
            scene.pump(&[Event {
                schema_version: SCHEMA_VERSION,
                partition: 0,
                sequence: 0,
                tick: 0,
                payload: EventPayload::ManualInject {
                    target: src_id,
                    port: 0,
                    item: Item(vec![0xA5]),
                },
            }]);
            scene.advance(16);
            if drain {
                let _ = scene.drain_effects();
            }
            scene.advance(16);
            (scene.hash(), postcard::to_allocvec(&scene.to_fixture()).expect("encode"))
        };
        assert_eq!(build(true), build(false), "draining changes no serialized byte");
    }
}
