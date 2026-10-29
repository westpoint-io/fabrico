//! The semantic command surface: `validate_normalize` + the `GridSession` driver.
//!
//! [`validate_normalize`] mirrors the host's `input_apply::apply_gesture`
//! (validate-then-produce, never optimistic-write) but is HEADLESS and produces a
//! RESOLVED [`EditRecord`] (decision Q2) instead of enqueuing an `EventPayload`. It
//! is generic over [`GridLookup`] so the live host reuses the IDENTICAL validation
//! in 08-06. [`GridSession`] ties validation, the edit-log, and the fold together
//! (added in this module's later section).

use std::collections::BTreeMap;

use fabrico_core::command::Command;
use fabrico_core::core::Core;
use fabrico_core::edit::{
    BeltEnd, BoxRestore, DeletedBelt, DeletedSelf, DeletedSubgraph, DeletedWire, EDIT_SCHEMA_VERSION, EditOp,
    EditRecord, MAX_ROUTE_EXPECT_BYTES, MAX_ROUTES, MachineConfig, PortSeat, SourceTrigger,
};
use fabrico_core::event::{Event, LogHeader, SCHEMA_VERSION};
use fabrico_core::fault::FAULT_PORT;
use fabrico_core::ids::{NodeId, PortId};
use fabrico_core::state::{
    Footprint, HttpMethod, LABEL_PLACED_FOOTPRINT, MAX_FOOTPRINT_DIM, Medium, Node, Port, Role, Side, SinkTemplate,
    UnlinkedDock, add_port_geometry, belt_end_world, cells_of_footprint, grow_to_fit, port_world,
    reseat_ports,
    unit_delta,
};
use fabrico_protocol::{
    CatalogPortView, GridCommand, MachineCatalogEntry, machine_kind, port_medium, port_role,
};

use crate::error::CommandError;
use crate::grid_view::{GridLookup, GridView, kind_byte};
use crate::route::route;

/// How many `Role::Out` ports a hand-placed Router carries: the number of BRANCH
/// TARGETS a routing table can address without the user adding a port first (ROUTE-02).
///
/// # This is the ONE source. Phase 65's rules editor reads THIS symbol.
/// Do NOT restate the number in the editor, in a panel arm, or in a palette
/// description. Phase 65 SC2 requires the port-catalog test to assert the EQUALITY
/// rather than a literal, and with the two halves of ROUTE-02 in different phases that
/// shared source has to live here or SC2 cannot be satisfied without writing the number
/// twice. `fabrico-command` is NOT frozen, so Phase 65 imports it freely.
///
/// # Why 3, argued rather than asserted
/// A routing table is an ordered list of rules plus a default. Two rules whose targets
/// differ, plus a default distinct from both, is the SMALLEST table that is actually a
/// branch: with two Outs the default has to double as a rule target, and with one Out
/// (which is what the catalog gave before 63-07) a two-rule table has nowhere to send
/// its second branch at all. The `MERGE`/`TEE` arms size themselves from
/// [`DEFAULT_ARITY`](fabrico_core::tick::DEFAULT_ARITY) (`2`), which is the house
/// precedent for a fan operator; a Router needs one more than a fan because its default
/// is a target in its own right.
///
/// Three is ALSO exactly what the Router's frozen `2x3` base admits, and that is a fact
/// worth stating rather than a coincidence to leave implicit.
/// [`base_footprint`](fabrico_core::state::base_footprint) hard-codes `Node::Router` at
/// `2x3` and lives in `fabrico-core`, which closes at the end of Phase 63. A fourth Out
/// takes `grow_to_fit`'s min-rect to `2x4`, which would move the catalog floor away from
/// the core's and break the base-parity test, a `fabrico-core` edit no later phase may
/// make. So 3 is simultaneously the smallest number that makes a branch meaningful and
/// the whole of what the frozen base holds.
///
/// The catalog value is a FLOOR, not a ceiling: `GridCommand::AddPort` grows a specific
/// node past it (and grows that node's footprint with it), which is a per-node fact
/// rather than a catalog fact.
pub const ROUTER_OUT_ARITY: u16 = 3;

/// True iff `kind` has an arm in [`port_catalog`] and may therefore reach it.
///
/// # The gate and the catalog are ONE contract
/// [`port_catalog`]'s final `_ => unreachable!()` is safe ONLY because
/// [`validate_normalize`]'s `Place` arm asks THIS question first. Any kind admitted here
/// MUST have a catalog arm, and any kind with an arm must be admitted here, or one of
/// the two halves is wrong. `configure.rs`'s `the_place_gate_and_the_catalog_are_one_contract`
/// walks the whole `u8` range and checks both directions, so the contract is machine-held
/// rather than remembered.
///
/// # Why an explicit ALLOW-SET and not a `kind <= MAX` bound (63-07)
/// Until 63-07 this was `if kind > machine_kind::SINK`, and the ENDPOINT work is exactly
/// the case that shows why a bound is the wrong shape. `SINK` is 7, `WIRE` is 8 and
/// `ENDPOINT` is 9, so raising the ceiling to admit 9 would ALSO have admitted 8, and a
/// `Place{WIRE}` must stay refused for the same reason a `Place{BELT}` is: a wire comes
/// only from `DrawWire`, as a belt comes only from `DrawBelt`. A `>` bound plus a
/// growing exclusion list admits every future appended byte by default and refuses it
/// only if someone remembers; an allow-set refuses by default and is a literal
/// transcription of the catalog's arm list, which is the thing it has to agree with.
///
/// `BELT` IS admitted here, because it has a catalog arm. It is refused immediately
/// after with the typed [`CommandError::BeltNotPlaceable`] (17-02), which is a different
/// and better answer than "unknown kind": the caller named a real machine kind and was
/// told the right way to build one.
#[must_use]
pub fn kind_has_catalog_arm(kind: u8) -> bool {
    matches!(
        kind,
        machine_kind::SOURCE
            | machine_kind::BELT
            | machine_kind::FACTORY
            | machine_kind::TEE
            | machine_kind::BALANCER
            | machine_kind::ROUTER
            | machine_kind::MERGE
            | machine_kind::SINK
            | machine_kind::ENDPOINT
            | machine_kind::HANDLER
            | machine_kind::LABEL
    )
}

/// The per-kind footprint + port catalog (FOOT-01/FOOT-03, CAT-01/03) — the SINGLE
/// authoritative resolver of a machine kind's footprint + ports, consulted by
/// [`validate_normalize`] at command-production time (Pattern 3, mirroring Phase 8 Q2
/// "store the resolved output") AND by [`catalog_entry`] to feed the pre-placement
/// ghost over the wire (CAT-05). The resolved `(Footprint, ports)` is FROZEN into the
/// produced [`EditOp::Place`], so the fold + every replay apply the frozen dims
/// VERBATIM and NEVER consult this catalog — replay stays catalog-independent. A
/// catalog edit that changes the resolution of NEW placements is therefore a
/// deliberate `EDIT_SCHEMA_VERSION`-bumping act; old logs keep their frozen layout.
///
/// # Per-kind catalog (17-01, CONTEXT Area 3 — locked)
/// Every valid non-BELT kind now resolves an EXPLICIT footprint + port set; the old
/// `_ => (1×1, [])` portless catch-all is GONE (CLEAN-08). Port convention: input
/// nubs on the WEST edge, output nubs on the EAST edge, sized to routing arity.
///
/// | Kind | Footprint | Ports (index → `local_offset` `side` `role`) |
/// |------|-----------|----------------------------------------------|
/// | FACTORY | 3×3 | 0:(0,1) W In · 1:(2,1) E Out · **2:(1,2) S Fault** |
/// | ROUTER | 2×3 | 0:(0,1) W In · 1:(1,1) E Out · 2:(1,2) E Out · 3:(1,0) E Out · 4:(0,2) S Fault |
/// | BALANCER | 2×2 | 0/1:(0,0)/(0,1) W In · 2/3:(1,0)/(1,1) E Out |
/// | TEE | 2×2 | 0:(0,0) W In · 1/2:(1,0)/(1,1) E Out (fan-out) |
/// | MERGE | 2×2 | 0/1:(0,0)/(0,1) W In · 2:(1,0) E Out (fan-in) |
/// | SOURCE | 1×1 | 0:(0,0) E Out |
/// | SINK | 1×1 | 0:(0,0) W In |
/// | ENDPOINT | 1×1 | 0:(0,0) W In **electrical** · 1:(0,0) E Out **electrical** |
/// | HANDLER | 3×3 | 0:(0,1) W In **electrical** · 1:(2,1) E Out **electrical** · 2:(1,2) S Fault |
/// | LABEL | 4x1 | (none: a note, it does not connect) |
/// | BELT | 1×1 (portless) | belt is not a real placeable, 17-02 rejects `Place{BELT}` |
///
/// The FACTORY `Fault` port is at array index 2 (S-center), so under the ROUTE-06
/// `(port_index asc)` ordering it sorts LAST. For BALANCER/TEE/MERGE the fan-side
/// port count equals [`DEFAULT_ARITY`](fabrico_core::tick::DEFAULT_ARITY) (`2`), the
/// arity `fold_place` mints (17-RESEARCH A5) — asserted in `port_catalog_*` tests.
///
/// BELT keeps a 1×1 portless entry for now purely so this plan stays build-green
/// while `Place{BELT}` is still reachable; 17-02 rejects BELT at `Place`, retiring
/// this arm. The final `_` is `unreachable!`: [`validate_normalize`] refuses any kind
/// for which [`kind_has_catalog_arm`] is false BEFORE calling, so no unarmed byte ever
/// reaches the catalog.
///
/// # This function's OUTPUT is serialized into FROZEN artifacts (63-07)
/// `validate_normalize`'s `Place` arm writes the resolved `(footprint, ports)` INTO
/// `EditOp::Place`, which is postcard-encoded into the golden corpus, the
/// `fabrico-scenario` fixtures and the shipped demo scene's pinned `tick_hash`. This
/// crate is not frozen and a later phase may edit it freely, but an edit HERE moves
/// bytes THERE, and only a phase that owns a corpus re-bless can pay for that: an
/// unfrozen function can still produce a frozen artifact.
/// The widest a label may be SIZED, in cells (phase 76, plan 76-02, UI-SPEC U-2): 16.
///
/// # A WRITE-side UI policy, NOT a data invariant (the `PaceOutOfRange` lesson)
/// The `Configure` validate arm refuses a CHANGE of width to more than this as
/// `OverLimit` (`Malformed` until plan 88-02), and the label panel's Width stepper stops here. An unchanged width past it
/// is accepted (plan 86-07, D-09): the panel resends the current size with every Apply, and
/// a label from a file must stay editable. Nothing on the load or replay path reads it:
/// the fold clamps a label's box only to `1..=MAX_FOOTPRINT_DIM`, the allocation-relevant
/// envelope, so a saved board carrying a wider label (written by a later UI with a larger
/// cap) still loads and replays. Applying a UI cap on load would make widening it a
/// save-breaking change. 16 by 8 holds the whole `MAX_LABEL_BYTES` text at the board's
/// word size; see that constant's docblock.
pub const LABEL_MAX_W: u16 = 16;

/// The deepest a label may be SIZED, in cells: 8. The same WRITE-side-only policy as
/// [`LABEL_MAX_W`], for the same reason.
pub const LABEL_MAX_H: u16 = 8;

#[must_use]
pub fn port_catalog(kind: u8) -> (Footprint, Vec<Port>) {
    match kind {
        machine_kind::SOURCE => (
            Footprint { w: 1, h: 1, rot: 0 },
            vec![Port { local_offset: (0, 0), side: Side::E, role: Role::Out, medium: Medium::Mechanical }],
        ),
        machine_kind::FACTORY => (
            Footprint { w: 3, h: 3, rot: 0 },
            vec![
                Port { local_offset: (0, 1), side: Side::W, role: Role::In, medium: Medium::Mechanical },
                Port { local_offset: (2, 1), side: Side::E, role: Role::Out, medium: Medium::Mechanical },
                // Fault at array index 2 (S-center) — sorts LAST (ROUTE-06).
                Port { local_offset: (1, 2), side: Side::S, role: Role::Fault, medium: Medium::Mechanical },
            ],
        ),
        machine_kind::TEE => (
            Footprint { w: 2, h: 2, rot: 0 },
            vec![
                Port { local_offset: (0, 0), side: Side::W, role: Role::In, medium: Medium::Mechanical },
                // Fan-out side = 2 outputs == DEFAULT_ARITY.
                Port { local_offset: (1, 0), side: Side::E, role: Role::Out, medium: Medium::Mechanical },
                Port { local_offset: (1, 1), side: Side::E, role: Role::Out, medium: Medium::Mechanical },
            ],
        ),
        machine_kind::BALANCER => (
            Footprint { w: 2, h: 2, rot: 0 },
            vec![
                // Both sides = 2 == DEFAULT_ARITY.
                Port { local_offset: (0, 0), side: Side::W, role: Role::In, medium: Medium::Mechanical },
                Port { local_offset: (0, 1), side: Side::W, role: Role::In, medium: Medium::Mechanical },
                Port { local_offset: (1, 0), side: Side::E, role: Role::Out, medium: Medium::Mechanical },
                Port { local_offset: (1, 1), side: Side::E, role: Role::Out, medium: Medium::Mechanical },
            ],
        ),
        machine_kind::ROUTER => {
            /// The Router's FROZEN base box. It is spelled here rather than inline
            /// because the arity bound below is checked against it.
            const ROUTER_BASE: Footprint = Footprint { w: 2, h: 3, rot: 0 };
            /// The E-column row of each Out, by catalog Out index. LITERAL, by the maintainer's
            /// ruling of 2026-10-04 ("Edits keep middle layout"): they are the rows the
            /// port-edit reseat rule (`fabrico_core::state::reseat_ports`, centre-out
            /// from the catalog box) gives a 3-long side, middle, then below, then
            /// above. Until plan 74.1-14 the first Out sat on row 2 (the pre-63-07
            /// exemplar's row) and the others on rows 0 and 1, so the Router's first
            /// port edit moved every Out and let go of every belt on them; the boards
            /// that docked the old cells were re-authored with this arm (the demo
            /// board's belts 11 and 14, scenario 01-exit-gate and 05-router-config, the
            /// golden generators that dock a catalog Router, named in the 74.1-14
            /// summary).
            ///
            /// WHY LITERAL AND NOT DERIVED: `reseat_catalog_layout.rs` pins
            /// `reseat_ports(base, catalog box, catalog ports) == catalog ports` for
            /// every arm. An arm computed by `reseat_ports` would make that pin compare
            /// the rule to itself and pass whatever the rule did. Typed by the arity, so
            /// a changed `ROUTER_OUT_ARITY` is a compile error here rather than a silent
            /// short or long row list.
            const OUT_ROWS: [i32; ROUTER_OUT_ARITY as usize] = [1, 2, 0];
            // ROUTE-02, machine-enforced rather than argued in prose: the Out arity has
            // to fit the frozen base, because `base_footprint(Node::Router)` in
            // `fabrico-core` hard-codes 2x3. A fourth Out takes `grow_to_fit`'s min-rect
            // to 2x4, the catalog floor and the core floor stop agreeing, and the
            // base-parity test fails, which is the RIGHT failure, but it should be a
            // compile error here rather than a surprise in a later phase.
            const _: () = assert!(
                ROUTER_OUT_ARITY <= ROUTER_BASE.h,
                "ROUTER_OUT_ARITY must fit the frozen 2x3 base_footprint(Node::Router)"
            );
            // `2 +`, not `1 +`: the In, the `ROUTER_OUT_ARITY` Outs, and the Fault nub.
            let mut ports = Vec::with_capacity(2 + ROUTER_OUT_ARITY as usize);
            // Index 0: the In, FIRST (a Head dock key is a raw catalog index), on the
            // middle row of the W column, (0,1), the reseat rule's slot for one In.
            ports.push(Port { local_offset: (0, 1), side: Side::W, role: Role::In, medium: Medium::Mechanical });
            // Indices 1..=ROUTER_OUT_ARITY: the Outs on the E column, rows 1, 2, 0.
            ports.extend(OUT_ROWS.iter().map(|&y| Port {
                local_offset: (i32::from(ROUTER_BASE.w) - 1, y),
                side: Side::E,
                role: Role::Out,
                medium: Medium::Mechanical,
            }));
            // Fault at the LAST array index (S of the bottom-LEFT cell, (0,2)): sorts
            // LAST (ROUTE-06), and it is also the reseat rule's slot for one Fault on a
            // 2-wide row. Pushed after the Outs so it stays last however the arity
            // moves.
            //
            // `(0, 2)` and not `(1, 2)`, on measurement: the bottom-left cell leaves
            // 38.480 px of bare ink gap to the nearest existing nub, where the
            // bottom-RIGHT cell leaves 10.585 px against an E-column Out on row 2.
            // It also keeps the fault exit off the E output column entirely, which is
            // the same separation argument the Sink and the Factory both make. Offsets
            // are 71-UI-SPEC's and are not re-derived here (ruling R-21).
            ports.push(Port {
                local_offset: (0, i32::from(ROUTER_BASE.h) - 1),
                side: Side::S,
                role: Role::Fault,
                medium: Medium::Mechanical,
            });
            (ROUTER_BASE, ports)
        }
        machine_kind::MERGE => (
            Footprint { w: 2, h: 2, rot: 0 },
            vec![
                // Fan-in side = 2 inputs == DEFAULT_ARITY.
                Port { local_offset: (0, 0), side: Side::W, role: Role::In, medium: Medium::Mechanical },
                Port { local_offset: (0, 1), side: Side::W, role: Role::In, medium: Medium::Mechanical },
                Port { local_offset: (1, 0), side: Side::E, role: Role::Out, medium: Medium::Mechanical },
            ],
        ),
        // SINK (PILE-10, 71-CONTEXT D-07): two ports on the ONE 1x1 cell, the ENDPOINT
        // arm's precedent, so the footprint does NOT grow.
        //
        // THE FAULT NUB IS ON S, AND E LOSES DESPITE HAVING THE BEST CLEARANCE. E has
        // 23.875 px of bare ink gap against S's 14.210 px, and it still loses, because
        // every other kind in this catalog puts its Out on E (SOURCE, FACTORY, TEE,
        // BALANCER, ROUTER, MERGE, ENDPOINT). A fault nub on a Sink's E side would sit
        // exactly where every reader expects the main output, so the fault drain would
        // read as the main line continuing - and a Sink is precisely the machine where
        // "the line continues" is the wrong idea. S is the FACTORY's own answer and it
        // puts the drain on a third axis from the W-in flow. N is geometrically equal to
        // S and is refused because the PILE-08 load gauge lives above the machine.
        // Offsets are 71-UI-SPEC's, which is APPROVED and BINDING; they are not
        // re-derived here (ruling R-21).
        machine_kind::SINK => (
            Footprint { w: 1, h: 1, rot: 0 },
            vec![
                Port { local_offset: (0, 0), side: Side::W, role: Role::In, medium: Medium::Mechanical },
                // Fault at array index 1 (S of the only cell): sorts LAST (ROUTE-06).
                Port { local_offset: (0, 0), side: Side::S, role: Role::Fault, medium: Medium::Mechanical },
            ],
        ),
        // ENDPOINT (63-07, WIRE-03): the host bridge. THE FIRST CATALOG ARM IN THIS
        // REPOSITORY WITH AN ELECTRICAL PORT - every one of the 17 ports across the arms
        // above is `Mechanical`, and until now the only electrical ports the command
        // layer could produce came from `place_router_preset(Medium::Electrical, ..)`
        // re-seeding via `AddPort`. Said here because a reader will otherwise assume
        // electrical catalog ports are routine, and the medium byte is the whole of what
        // makes an endpoint an endpoint: `DrawWire` refuses anything else.
        //
        // 1x1 with both nubs on the ONE cell, In facing W and Out facing E, exactly as
        // SOURCE and SINK put their single port at (0,0). That keeps the arm equal to
        // the core's `base_footprint(Node::Endpoint)`, which is `1x1` and lives in
        // `fabrico-core`; the base-parity test pins the two, and `fabrico-core` closes at
        // the end of Phase 63, so a 2x1 arm here would need a frozen-crate edit to stay
        // honest.
        //
        // Stated exactly rather than flatteringly: `grow_to_fit` would compute a MIN-RECT
        // of 2x1 for one In plus one Out, so this declared box is one column SMALLER than
        // the min-rect for its own port list. That is safe and it is not an accident.
        // Validate and fold compute the SAME box through `add_port_geometry`, so a later
        // `AddPort` on an endpoint resizes it to exactly the box the fold produces. What
        // it does mean is that the first port add on an endpoint moves it from 1x1 to a
        // 2-wide box (an In and an Out need a column each), which is a visible jump and a
        // deliberate one. Since 74.1-16 one Ctrl+Z of that add returns it to 1x1, because
        // the add's inverse carries the box it grew from.
        machine_kind::ENDPOINT => (
            Footprint { w: 1, h: 1, rot: 0 },
            vec![
                // In FIRST, per the invariant `port_catalog_every_kind_lists_in_ports_first`
                // pins: a Head dock key is a raw catalog index, so an Out declared before
                // an In would mis-key every Head dock into the wrong inbox.
                Port { local_offset: (0, 0), side: Side::W, role: Role::In, medium: Medium::Electrical },
                Port { local_offset: (0, 0), side: Side::E, role: Role::Out, medium: Medium::Electrical },
            ],
        ),
        // HANDLER (72-05, SERVE-03): user code a webhook reaches over a wire. It is the
        // SECOND catalog arm in this repository with an electrical port, and the first
        // that is a full 3x3 machine rather than a 1x1 bridge.
        //
        // THE THREE `local_offset` VALUES ARE COPIED VERBATIM FROM THE FACTORY ARM
        // ABOVE, and that is deliberate rather than lazy. A Handler folds to a
        // `Node::Factory` (D-11) and therefore stands on the FACTORY's chassis: the same
        // 3x3 box, the same three nub clearances, already measured, shipped and pinned.
        // Deriving a second set of offsets for a machine on the same chassis is a second
        // derivation of solved geometry, which is the ruling `71-UI-SPEC` R-21 already
        // made for the Router. Only the `medium` field on indices 0 and 1 differs.
        //
        // ONE ELECTRICAL OUT, AND THE ARITY IS LOAD-BEARING RATHER THAN MERELY
        // SUFFICIENT. 72-CLEAN-DESIGN recommended three Outs; D-02 overrides it with
        // one. The reason to record HERE, at the call site, is not that one is enough.
        // It is that with a SINGLE Out, a second Route's return cable is refused
        // `CommandError::PortOccupied` at the `DrawWire` from-port rule below (the
        // `link_exists || wire_from_port_exists` check), so THIS PORT LIST is what makes
        // the one-request-one-reply shape the only board a user can build. Three Outs
        // would permit a board D-01 rules out, and the number three was copied from
        // `ROUTER_OUT_ARITY` with no derivation behind it. A later reader who finds one
        // Out and no reason will read it as a limitation and widen it.
        //
        // INDEX 0 IS LOAD-BEARING AND NOT COSMETIC. `step_factory` drains inbox port 0
        // ONLY (`factory.rs`), and since plan 72-03 the DECLARED MEDIUM of that port is
        // the whole discriminator between a mechanical Factory and an electrical
        // Handler (D-16, read through `admit::inbox_class`). An electrical In appended
        // AFTER the three mechanical catalog ports would strand every request on a board
        // that looks correct. In ports come FIRST regardless, per the shipped invariant
        // `port_catalog_every_kind_lists_in_ports_first`: a Head dock key is a raw
        // catalog index, so an Out declared before an In mis-keys every Head dock into
        // the wrong inbox.
        machine_kind::HANDLER => (
            Footprint { w: 3, h: 3, rot: 0 },
            vec![
                Port { local_offset: (0, 1), side: Side::W, role: Role::In, medium: Medium::Electrical },
                Port { local_offset: (2, 1), side: Side::E, role: Role::Out, medium: Medium::Electrical },
                // Fault at array index 2 (S-center), MECHANICAL: a fault drain carries
                // items, not requests. Sorts LAST (ROUTE-06), exactly as on the FACTORY.
                Port { local_offset: (1, 2), side: Side::S, role: Role::Fault, medium: Medium::Mechanical },
            ],
        ),
        // BELT is not a real placeable machine; 17-02 rejects `Place{BELT}`. Until
        // then it resolves to a 1×1 portless footprint so replay stays byte-stable.
        // LABEL (phase 76, SHAPE-10): a note on the board. The ONE shared box the core's
        // `base_footprint` reads too (so the W1 parity test holds by one constant) and NO
        // ports: a label does not connect (D-07). An empty list keeps the `ports` map free
        // of an entry for it, exactly as the fold writes no entry for an empty list.
        machine_kind::LABEL => (LABEL_PLACED_FOOTPRINT, vec![]),
        machine_kind::BELT => (Footprint { w: 1, h: 1, rot: 0 }, vec![]),
        // Unreachable: validate_normalize refuses any kind for which
        // [`kind_has_catalog_arm`] is false, as UnknownKind, BEFORE resolving the
        // catalog. The allow-set and the arms above are ONE contract and
        // `the_place_gate_and_the_catalog_are_one_contract` walks the whole u8 range in
        // both directions to hold it. This is NOT a portless catch-all (CLEAN-08): every
        // admitted kind has an explicit arm.
        _ => unreachable!("port_catalog called with kind {kind}, which has no arm; \
                           validate_normalize refuses it via kind_has_catalog_arm"),
    }
}

/// The wire `u8` a core [`Role`] rides as in the catalog surface (`In=0, Out=1,
/// Fault=2`) — an explicit match (not an `as u8` cast) decouples the wire byte from
/// the enum's in-memory layout, mirroring the render packet's `role_u8` (PORT-02).
#[must_use]
fn catalog_role_u8(role: Role) -> u8 {
    match role {
        Role::In => port_role::IN,
        Role::Out => port_role::OUT,
        Role::Fault => port_role::FAULT,
    }
}

/// The wire `u8` a core [`Side`] rides as in the catalog surface (`N=0, E=1, S=2,
/// W=3`) — explicit match (PORT-02), mirroring the render packet's `side_u8`.
#[must_use]
fn catalog_side_u8(side: Side) -> u8 {
    match side {
        Side::N => 0,
        Side::E => 1,
        Side::S => 2,
        Side::W => 3,
    }
}

/// The wire `u8` a core [`Medium`] rides as in the catalog surface (`Mechanical=0,
/// Electrical=1`) — an explicit match (not an `as u8` cast) decouples the wire byte
/// from the enum's in-memory layout, mirroring [`catalog_role_u8`] (35-03).
#[must_use]
fn catalog_medium_u8(medium: Medium) -> u8 {
    match medium {
        Medium::Mechanical => port_medium::MECHANICAL,
        Medium::Electrical => port_medium::ELECTRICAL,
    }
}

/// Build the authoritative pre-placement [`MachineCatalogEntry`] for `kind` from the
/// SINGLE source of truth [`port_catalog`] (CAT-05, produce half). This is the
/// ts-rs-exported surface the placement GHOST sizes itself from, replacing the
/// frontend's hand-maintained `dimsForKind` (deleted in 17-03). The footprint + rot-0
/// port geometry are copied VERBATIM from `port_catalog`; `Role`/`Side` map to their
/// wire bytes via [`catalog_role_u8`]/[`catalog_side_u8`]. This is the ONLY producer
/// — never hand-copy the catalog (threat T-17-CAT-DRIFT).
#[must_use]
pub fn catalog_entry(kind: u8) -> MachineCatalogEntry {
    let (footprint, ports) = port_catalog(kind);
    MachineCatalogEntry {
        kind,
        w: footprint.w,
        h: footprint.h,
        rot: footprint.rot,
        ports: ports
            .iter()
            .enumerate()
            .map(|(i, p)| CatalogPortView {
                index: u16::try_from(i).unwrap_or(u16::MAX),
                local_x: p.local_offset.0,
                local_y: p.local_offset.1,
                side: catalog_side_u8(p.side),
                role: catalog_role_u8(p.role),
                medium: catalog_medium_u8(p.medium),
            })
            .collect(),
    }
}

/// The two ROUTE-06 palette PRESETS the frontend lists — HTTP Router
/// (`Medium::Electrical`) and Item Router (`Medium::Mechanical`) — as
/// [`MachineCatalogEntry`] values BOTH carrying `kind = machine_kind::ROUTER` and
/// differing PURELY in the `medium` byte of their In and Outs (the Fault is Mechanical
/// on both since plan 85-05, D-22). There is NO new serialized type, NO
/// new `machine_kind`, and NO new field on `MachineCatalogEntry`: the two presets ride
/// the EXISTING ts-rs-exported catalog surface (one engine, two presets).
///
/// Both entries are derived from [`router_preset_ports`] through the SAME
/// [`catalog_entry`]-style mapping (the single catalog producer, threat T-17-CAT-DRIFT /
/// T-36-08), so the palette geometry can never drift from what
/// [`place_router_preset`](GridSession::place_router_preset) actually seeds.
#[must_use]
pub fn router_presets() -> Vec<MachineCatalogEntry> {
    // HTTP (electrical) first, then Item (mechanical) — order is presentation-only.
    [Medium::Electrical, Medium::Mechanical]
        .into_iter()
        .map(router_preset_entry)
        .collect()
}

/// One ROUTE-06 preset descriptor: a `kind = ROUTER` [`MachineCatalogEntry`] whose
/// ports are [`router_preset_ports`]`(medium)` mapped through the SAME
/// `catalog_*_u8` helpers [`catalog_entry`] uses. Differs from a sibling preset ONLY in
/// the `medium` byte (one Router engine, two presets) — adds no new serialized shape.
#[must_use]
fn router_preset_entry(medium: Medium) -> MachineCatalogEntry {
    let base = port_catalog(machine_kind::ROUTER).0;
    let ports = router_preset_ports(medium);
    let fp = grow_to_fit(base, &ports);
    MachineCatalogEntry {
        kind: machine_kind::ROUTER,
        w: fp.w,
        h: fp.h,
        rot: fp.rot,
        ports: ports
            .iter()
            .enumerate()
            .map(|(i, p)| CatalogPortView {
                index: u16::try_from(i).unwrap_or(u16::MAX),
                local_x: p.local_offset.0,
                local_y: p.local_offset.1,
                side: catalog_side_u8(p.side),
                role: catalog_role_u8(p.role),
                medium: catalog_medium_u8(p.medium),
            })
            .collect(),
    }
}

/// The canonical Router PRESET port list at `medium`: one `Role::In` facing W followed
/// by [`ROUTER_OUT_ARITY`] `Role::Out` ports facing E, then one `Role::Fault` facing S
/// at `Medium::Mechanical` for BOTH presets (plan 85-05, D-22), seated by
/// [`grow_to_fit`]/[`reseat_ports`] onto the frozen Router base `2x3` FLOOR, EXACTLY as
/// the fold produces it from the `Place{ROUTER}` + `AddPort` seeding of
/// [`place_router_preset`](GridSession::place_router_preset). This is the SINGLE
/// producer of preset geometry (mirroring [`catalog_entry`]'s single-source discipline,
/// threat T-17-CAT-DRIFT): the palette view ([`router_presets`]) derives its two entries
/// from HERE, and so does the seeding itself, so listed geometry can never drift from
/// what the seeding actually mints.
///
/// # The Out count is DERIVED (ROUTE-02, plan 65-05)
/// Until 65-05 this claim of being the single producer was FALSE in the one direction
/// that reached a user: the list was a hand-written 1-in/2-out `vec!` and
/// `place_router_preset` did not call it at all, writing its own three literal `AddPort`
/// legs instead. So Phase 63 widened `port_catalog(ROUTER)` to [`ROUTER_OUT_ARITY`]
/// Outs while the only Router a user could actually place still carried two, and
/// `ROUTER_OUT_ARITY`'s own docblock argues two is not a branch. The count now comes
/// from that constant and the seeding consumes THIS function, so the two cannot diverge
/// again.
///
/// # Why the In stays first
/// [`reseat_ports`] assigns a port's slot from its 0-based index AMONG ITS ROLE in list
/// order (centre-out from the catalog box since plan 74.1-14: the In on the middle row,
/// the Outs on rows 1, 2, 0). Since 74.1-16 the host fold seats each added port on the
/// first free slot of its role instead, and on the emptied preset machine, filled in this
/// order, that is the same slot, so list ORDER is still load-bearing geometry rather than
/// presentation. The In comes first because a Head
/// dock key is a raw catalog index. Since 74.1-14 the preset seats its In and Outs on
/// exactly the catalog Router's cells, and since 85-05 its Fault on the catalog's Fault
/// cell `(0, ROUTER_BASE.h - 1)` facing S, so the two palette presets and a catalog
/// Router differ only by the medium of the In and the Outs, never by where a nub is.
///
/// # The Fault port (plan 85-05, D-22, GATE-06)
/// Until 85-05 this list carried NO Fault while the browser seeded the whole catalog
/// row, Fault included, so the Rust preset was a four-port Router and the palette one a
/// five-port Router (WINDOWS 170). The Fault is appended LAST, after the Outs, so every
/// In and Out keeps its index. Its medium is `Mechanical` for BOTH presets, not the
/// preset medium: a Router's fault is an ITEM the Router could not route, and items
/// ride belts (the Handler precedent). Seeded at the preset medium, the HTTP Router's
/// fault nub was Electrical, which a belt refuses to dock and a wire cannot leave, so it
/// was a nub nothing could attach to; plan 85-05 confirmed that on the real host before
/// changing it (`16-router-presets.spec.ts`, the fault-nub leg).
///
/// # ROUTE-06 zero-serialized-change (CONTEXT hard rule)
/// The two palette presets — HTTP Router (`Medium::Electrical`) and Item Router
/// (`Medium::Mechanical`) — are TWO views over the ONE `Node::Router` engine, differing
/// PURELY by `Port.medium`. There is NO new `machine_kind`, NO new catalog field, NO
/// new serialized shape: `medium` is the ONLY parameter, and routing is NOT forked.
#[must_use]
fn router_preset_ports(medium: Medium) -> Vec<Port> {
    let base = port_catalog(machine_kind::ROUTER).0;
    // One In then ROUTER_OUT_ARITY Outs at `medium`, then the Fault at Mechanical. The
    // `local_offset`s are placeholders: reseat_ports recomputes every one of them as a
    // pure function of list position, which on a hole-free fill is the slot the fold's
    // first-free seat gives (74.1-16); it seats the one Fault at (0, ROUTER_BASE.h - 1),
    // the catalog's Fault cell. The Out count is DERIVED and appears NOWHERE as a literal.
    let mut ports = Vec::with_capacity(2 + ROUTER_OUT_ARITY as usize);
    ports.push(Port { local_offset: (0, 0), side: Side::W, role: Role::In, medium });
    ports.extend((0..ROUTER_OUT_ARITY).map(|_| Port {
        local_offset: (0, 0),
        side: Side::E,
        role: Role::Out,
        medium,
    }));
    ports.push(Port { local_offset: (0, 0), side: Side::S, role: Role::Fault, medium: Medium::Mechanical });
    let fp = grow_to_fit(base, &ports);
    reseat_ports(base, fp.w, fp.h, &ports)
}

/// The inclusive grid bound (mirror `input_apply::GRID_MAX`). A placement outside
/// `[GRID_MIN, GRID_MAX]` on either axis is rejected: grid extent is a presentation
/// concern, kept out of the spatial-model-free deterministic core.
pub const GRID_MAX: i32 = 512;
/// The inclusive lower grid bound (see [`GRID_MAX`]).
pub const GRID_MIN: i32 = -512;

/// True iff `cell` is within the inclusive grid bound on both axes.
#[must_use]
fn in_bounds(cell: (i32, i32)) -> bool {
    (GRID_MIN..=GRID_MAX).contains(&cell.0) && (GRID_MIN..=GRID_MAX).contains(&cell.1)
}

/// Fold ONE prospective inverse `op` on a THROWAWAY prediction core (12-05) to learn the
/// ids it mints — slotmap minting is a deterministic function of allocator state, so the
/// ids harvested here equal the ones the real one-tick [`GridSession::append_inverse_group`]
/// fold will mint. Each call is its own tick, so `core.last_tick.placed` holds exactly this
/// op's mint(s); tick grouping never perturbs the (purely allocator-sequential) mint order
/// — the SAME determinism guarantee `reconstruct_projection`'s throwaway re-fold relies on.
fn fold_predict(core: &mut Core, op: &EditOp) {
    let rec = EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: 0,
        tick: core.tick,
        action: 0,
        op: op.clone(),
    };
    core.advance_edits(std::slice::from_ref(&rec), &[]);
}

/// THE RESTORE-SPACE GUARD (phase 86, plan 86-06, WORK-02, D-04): is every cell a Delete
/// undo is about to claim back still free on `board`?
///
/// `board` is ALWAYS the prediction core `pred` of [`compute_inverse`](GridSession::compute_inverse),
/// the board as the group's EARLIER records leave it, and never the live `self.core`. The
/// difference is load-bearing: the undo of a Move walks its `Place` leg first, whose
/// inverse Deletes the moved machine and frees its new cells on `pred`, and only then
/// re-Places the original; read against the live core, a one-cell move would be refused
/// against the moved machine's own cells. It is read before the claim folds (a claim
/// overwrites the occupancy it reads), and a `false` is returned as
/// [`CommandError::UndoSpaceTaken`] before the group is: a refused Undo emits no record,
/// `resolve_undo` (which is `&self`) mutates nothing, the host's `apply_gesture` enqueues
/// nothing, and the step stays on top of the undo stack. Every check site only RECORDS a
/// taken cell; the refusal is returned once the whole reverse walk has finished with no
/// structural refusal, so a record no fold can restore keeps its `UndoDoesNotFit` against every
/// later check, not only the minted one (phase 86 review, WR-02).
///
/// Staying on top of the stack does NOT make the step undoable once the space is cleared
/// (phase 86 review, WR-01). Under linear undo whatever clears it (a Delete or a move of
/// the blocker) is a new step above the refused one, so the next Ctrl+Z puts the blocker
/// back and the one after is refused again: the refused step and every earlier step stay
/// out of reach, and nothing on the board changes.
///
/// A fold that claims a held cell does not fail: `claim_footprint` and `claim_belt_tiles`
/// overwrite the occupancy index, the neighbour is left on cells no one owns, and the
/// saved board is refused on open (`CellCollision`). With linear undo no ordinary gesture
/// reaches this; only a forged or hand-edited file does, and the guard keeps every board
/// loadable against one.
fn restore_cells_free(board: &Core, mut cells: impl Iterator<Item = (i32, i32)>) -> bool {
    cells.all(|c| board.state.occupied(c).is_none())
}

/// THE LABEL RE-GROW GUARD (phase 86 security audit, threat T-86-15): is every cell the
/// Delete undo's re-`Configure` of a label will claim free on `board`, or already the
/// label's own?
///
/// A label's box is set twice by its Delete undo: the re-`Place` claims the CAPTURED box,
/// which [`restore_cells_free`] checks, and the always-appended re-`Configure` (D-02) then
/// re-grows the box to the CONFIG's width and depth through `resize_label_box`, which
/// claims cells with no check. An honest capture and its config agree, so the second claim
/// is the first one. A forged Delete can disagree: measured, a 1 by 1 capture of a 4 by 1
/// label with its anchor moved next to a Source passed the capture check, the re-Configure
/// grew the label over the Source, and the board saved into a file refused
/// `CellCollision`. So this checks the box the re-`Configure` really claims, read from the
/// core's own [`label_box_after_resize`](fabrico_core::state::GridState::label_box_after_resize).
///
/// `board` is `pred` with the label already re-Placed, so a cell holding `id` is the
/// label's own capture box, and free for it. `true` for any config that is not a label's
/// or any node that is not a live label: no other `Configure` claims a cell.
fn label_regrow_cells_free(board: &Core, id: NodeId, config: &MachineConfig) -> bool {
    let (MachineConfig::Label { w, h, .. }, Some(Node::Label(_))) = (config, board.state.node(id))
    else {
        return true;
    };
    let Some((anchor, fp)) = board.state.label_box_after_resize(id, *w, *h) else {
        return true;
    };
    cells_of_footprint(anchor, fp.w, fp.h, fp.rot)
        .all(|c| board.state.occupied(c).is_none_or(|owner| owner == id))
}

/// The TARGET-IDENTITY GUARD (51-05, threat T-51H-01): is `id` — the node an inverse
/// `Delete` is about to name — actually the node the original record DESCRIBES?
///
/// # What it is for, and what it costs
/// A projection that has lost id alignment with the live core (the class of defect
/// 51-04 fixed the live instance of, and which a session rebuilt by
/// [`GridSession::replay_two_logs`] still reaches whenever the core it is handed holds
/// nodes its edit log never minted, as a hand-edited file whose saved board and edit log
/// disagree does) must surface as a typed refusal, NEVER as the silent destruction of a
/// bystander node. The measured symptom, on the shipped demo board of the time (whose
/// request pair was then minted outside the log), was one Ctrl+Z after placing a machine
/// leaving the machine standing and deleting a cable node instead; the board-level
/// reproduction now lives in `crates/fabrico-host/tests/undo_on_demo_board.rs`,
/// `misaligned_place_undo_is_refused_not_destructive`, built from a trimmed log. The COST is that the
/// undo does not happen. It is no longer SILENT: since Phase 64 the gesture drain
/// (`SimLoop::acquire_input` in `crates/fabrico-host/src/sim_loop.rs`) answers the
/// gesture envelope's reply with this verdict instead of discarding it, so
/// `CommandError::UndoDoesNotFit` crosses the wire as the `UndoDoesNotFit` tag and a
/// refused Ctrl+Z reads "That step no longer fits the board." (`REFUSAL_COPY` in
/// `frontend/src/chrome/RefusalMessage.tsx`; `Malformed` and its no-cause sentence until
/// plan 88-02). Bounded and said out loud, not repaired.
///
/// On the UNDO arms, reads are taken from `pred`, the walked-forward prediction core
/// the inverse will actually fold against, so the check reflects the state at fold time
/// (not the live `self.core`). `cell` is `Some` only for a `Place` inverse: a
/// `DrawBelt` inverse carries a sentinel `(0, 0)` cell by construction and a belt has
/// no anchor, so the cell clause is skipped for belts. `cell_of` returns the ANCHOR. Since
/// 74.1-16 a growing `AddPort` on a turned machine shifts it (review WR-01), and that
/// add's own inverse carries the pre-add anchor back (`RemovePort.restore`), so by the
/// time the Place inverse is checked the anchor is the placed one again, which is what
/// lets the cell clause survive an `AddPort` in the same history.
///
/// A legitimate group always passes — its ids come from the very fold that minted them
/// — so the happy path is byte-identical.
///
/// THREE call sites, one per `Delete`-emitting seam in [`compute_inverse`](GridSession::compute_inverse):
/// the `Place` and `DrawBelt` UNDO arms (T-51H-01), and the `Delete` REDO arm (UO-1 —
/// the symmetric mirror, added because a guard on one direction of a symmetric
/// operation is not a guard). The redo site reads `self.core` and pre-filters on
/// "target is live" so an ABSENT target skips instead of refusing; see that arm's
/// comment for why that discrimination is load-bearing.
fn inverse_target_matches(
    pred: &Core,
    id: NodeId,
    kind: u8,
    cell: Option<(i32, i32)>,
) -> bool {
    let Some(node) = pred.state.node(id) else {
        return false;
    };
    // The kind capture and the ports are read from the SAME `pred` core and keyed by
    // the SAME id, so this cannot compare one node's variant against another's ports.
    // Since 72-06 a Handler is a `Node::Factory` distinguished ONLY by its port list,
    // so a mapper that could not see the ports would report FACTORY for a captured
    // HANDLER and this guard would refuse a legitimate undo.
    if kind_byte(node, pred.state.ports_of(id)) != kind {
        return false;
    }
    match cell {
        Some(c) => pred.state.cell_of(id) == Some(c),
        None => true,
    }
}

/// Severed docks attributed to the severing records of one fold batch: one
/// `((action, sequence), docks)` entry per severing record, in record order.
type Severances = Vec<((u64, u64), Vec<UnlinkedDock>)>;

/// Attribute a fold's severed docks (`last_tick.unlinked`) to the `Rotate` records of the
/// batch that produced them, node-keyed, returning one `((action, sequence), docks)` entry
/// per `Rotate` in `records` — an EMPTY vec included.
///
/// # ONE rule, ONE function (67-REVIEW WR-04)
/// This is called from BOTH severed-dock harvests: the live one in
/// [`GridSession::capture_after_fold`] and its reconstruct-time twin inside
/// [`GridSession::reconstruct_projection`]. They were two hand-maintained copies of the
/// same attribution and only the live copy carried the A3 check below — backwards relative
/// to the risk, since the twin is the AUTHORITATIVE half on the load path (the one path
/// the live map cannot cover) and [`GridSession::replay`] is a `pub` primitive a
/// hand-edited or forged log reaches. One function is what stops them drifting.
///
/// # EVERY Rotate, empty vec included (67-REVIEW CR-01)
/// Absence of a key must mean "no `Rotate` record here", never "a `Rotate` that severed
/// nothing" — `reconstruct_projection`'s live-wins merge distinguishes exactly those two
/// readings, and conflating them let a re-fold-invented severance be folded as a real
/// `Dock`. Callers read the map with `.get()` and iterate, so a `Some(empty)` emits
/// nothing and the happy path is unchanged.
///
/// # Attribution is by `UnlinkedDock.node`, never positional
/// A `Rotate` emits a VARIABLE number of `UnlinkedDock`s (0..n), so the `mint_idx`
/// stepping the placed-id harvest uses cannot be reused here. See
/// `capture_after_fold`'s "Severed-dock attribution" docblock.
///
/// # THREE severing ops since 74.1-12: `AddPort` joined `Rotate` and `RemovePort`
/// Since 74.1-12 both port-edit folds keep a re-keyed belt dock only while its port still
/// faces the belt end, so an `AddPort` that moves a nub releases that nub's belt and
/// records it on `last_tick.unlinked` exactly as a `RemovePort` does. Since 74.1-16 no
/// command-built add moves a docked nub (the validate arm refuses a growth over a docked
/// belt's end tile), so this records something only on a forged log, which is what it is
/// kept for. It is named in `severing_node` below, the one place the set lives,
/// so the A3 check and the attribution widened together. MEASURED for A3: the one
/// command-produced batch that names a node in several port edits at once is the Router
/// preset burst (`seedRouterPreset`: five `RemovePort`s then five `AddPort`s), and it runs
/// on a machine placed in that same gesture with nothing docked, so its `unlinked` is
/// empty and the check is not reached.
///
/// # TWO severing ops since 73-06, not one, and BOTH matchers below widened
/// `Rotate` was the sole writer of `core.last_tick.unlinked` from 67-03 until phase 73.
/// `RemovePort` joined it (UNDO-05): removing a port releases the dock that was ON it,
/// through the same `GridState::judge_docks` machinery with its own verdict. This
/// function filtered the op set in TWO places (the A3 `debug_assert!` and the
/// `filter_map`) and both had to widen together. Widening only one leaves the other path's
/// severances attributed under no key at all, which is the silent-stranded-belt defect
/// 67-03 closed. They are now ONE `severing_node` helper, so the two cannot drift.
///
/// A SECOND MATCHER BESIDE THIS ONE IS THE DEFECT, NOT THE FIX. 67-REVIEW WR-04 merged two
/// hand-maintained copies into this single function precisely because only one of them
/// carried the A3 check. `capture_after_fold` and `reconstruct_projection` both call HERE.
///
/// # Research assumption A3 FELL in phase 89, and attribution is now exact
/// Until phase 89 this section read "no batch a `GridSession` log can produce names the same
/// node in two severing records" and a `debug_assert!` checked it. Plan 89-01 measured it
/// false on the shipped host: on a paused board R then Shift+R queue two `Rotate`s of one
/// machine in one drain pass, `fold_live` folds the pass at once, and the assertion fired
/// inside `Host::tick_once` (`rotate_redock_same_pass.rs`). In a release build the two
/// records' severances merged under one node key, so the Undo of the turn back would have
/// re-docked what the turn away cut, at a rotation where that dock cannot reach.
///
/// So a batch that names one node in two or more severing records
/// ([`severances_need_split`]) is attributed RECORD BY RECORD: its caller folds the batch one
/// record at a time on a scratch clone of the pre-fold core ([`split_severances`], the pattern
/// `capture_slice` uses for a node named twice) and hands the per-record lists in as `split`.
/// Every other batch keeps the node-keyed read below, byte for byte. Either way the result is
/// CHECKED: every severance in `unlinked` is attributed exactly once (a `debug_assert!`), so a
/// caller that forgot the split, or a split that disagrees with the real fold, is loud.
fn attribute_severances(
    records: &[EditRecord],
    unlinked: &[UnlinkedDock],
    split: Option<Severances>,
) -> Severances {
    let out: Severances = match split {
        Some(per_record) => per_record,
        None => records
            .iter()
            .filter_map(|r| {
                severing_node(&r.op).map(|node| {
                    (
                        (r.action, r.sequence),
                        unlinked.iter().copied().filter(|u| u.node == node).collect(),
                    )
                })
            })
            .collect(),
    };
    debug_assert!(
        {
            let attributed: Vec<UnlinkedDock> = out.iter().flat_map(|(_, v)| v.iter().copied()).collect();
            attributed.len() == unlinked.len()
                && unlinked.iter().all(|u| {
                    attributed.iter().filter(|a| *a == u).count() == unlinked.iter().filter(|x| *x == u).count()
                })
        },
        "A3: every severance of a batch is attributed to exactly one severing record \
         (a batch naming one node twice must be attributed record by record)"
    );
    out
}

/// The node a record severs docks on, or `None` if the op severs nothing. THE ONE place the
/// severing-op set is named, so the split decision, the split itself and the node-keyed
/// attribution cannot drift apart the way two hand-written matchers did before 67-REVIEW
/// WR-04.
fn severing_node(op: &EditOp) -> Option<NodeId> {
    match op {
        EditOp::Rotate { node, .. } | EditOp::RemovePort { node, .. } | EditOp::AddPort { node, .. } => {
            Some(*node)
        }
        _ => None,
    }
}

/// Does `records` name one node in two or more severing records? Then the node-keyed read
/// of [`attribute_severances`] would merge their severances, and the batch is attributed
/// record by record instead (phase 89, the paused turn away and back).
fn severances_need_split(records: &[EditRecord]) -> bool {
    let mut seen: Vec<NodeId> = Vec::new();
    records.iter().filter_map(|r| severing_node(&r.op)).any(|n| {
        let twice = seen.contains(&n);
        seen.push(n);
        twice
    })
}

/// Each severing record's own severances, read by folding `records` one at a time on a
/// scratch clone of `pre` (the core BEFORE the batch folds) with the core's own fold, its
/// commands and tick discarded, and reading `last_tick.unlinked` after each. Keyed
/// `(action, sequence)` like [`attribute_severances`]' answer, one entry per severing record,
/// an empty one included. The fold folds a batch's records in order, so the per-record lists
/// concatenate to the batch's `unlinked`; [`attribute_severances`] checks that they do.
fn split_severances(pre: &Core, records: &[EditRecord]) -> Severances {
    let mut scratch = pre.clone();
    let mut out = Vec::new();
    for r in records {
        let _discarded = scratch.advance_edits(std::slice::from_ref(r), &[]);
        if severing_node(&r.op).is_some() {
            out.push(((r.action, r.sequence), scratch.last_tick.unlinked.clone()));
        }
    }
    out
}

/// Is a compensating `EditOp::Dock` read off a severed-dock capture SAFE to fold against
/// `pred` — a live BELT and a live machine (67-REVIEW CR-01, second half)?
///
/// Every other minting inverse arm in `compute_inverse` runs
/// [`inverse_target_matches`] before it emits; the Rotate compensation shipped without
/// one, which is why an invented capture could reach `fold_dock` at all.
///
/// # This is NOT the CR-01 fix and must not be read as one
/// The invention that motivated CR-01 named ids the live core really held — a real belt
/// and a real machine, just the WRONG pair — so it passes this check cleanly. The fix is
/// in [`GridSession::capture_after_fold`]: absence in `live_severed_docks` now means "not
/// folded live". This is the floor UNDER that fix, for the one path the live map cannot
/// cover: a LOAD, where `severed_docks` comes wholly from the throwaway re-fold and
/// [`GridSession::replay`] is a `pub` primitive a forged or hand-edited log reaches.
///
/// # The callers answer `false` DIFFERENTLY, and this predicate does not decide which
/// It reports foldability; the policy belongs to each arm and is written at each arm.
///
/// - The `Rotate` arm `continue`s on `false`. Refusing the whole undo over a stale capture
///   is the capture-miss-is-refusal clause that arm deliberately does not copy: it would
///   refuse the undo of an ordinary rotate, because that arm's capture can be an invention
///   of the throwaway re-fold. Emitting nothing degrades to the pre-Phase-67 behaviour for
///   that one dock instead.
/// - The `RemovePort` arm (73-06, R-28) returns `UndoDoesNotFit` on `false`. Its entry exists
///   only because `fold_remove_port` RECORDED a release, so an entry that cannot be
///   inverted means the capture broke, and restoring the port without its belt would hand
///   back a different board while reporting success.
/// - The `AddPort` arm (74.1-12) takes the `RemovePort` arm's policy for the same reason:
///   its entry exists only because `fold_add_port` recorded a release.
///
/// # The BELT side carries a kind clause and the machine side does not
/// A dock's machine may be any port-bearing kind, but its belt is a BELT.
/// [`fold_dock`](fabrico_core::tick) checks only that both ids EXIST (`tick.rs:589`)
/// before `GridState::link`'s bare `insert` (`state.rs:1359`), so without the kind clause
/// a capture naming a machine where a belt belongs would still be written into real state.
fn compensating_dock_is_foldable(pred: &Core, belt: NodeId, node: NodeId) -> bool {
    inverse_target_matches(pred, belt, machine_kind::BELT, None) && pred.state.node(node).is_some()
}

/// The refuse-vs-skip discriminator for the `Configure` capture-miss (51-05, threat
/// T-51H-03): is `id` a LIVE node in `pred` whose kind matches `config`'s variant?
///
/// `true` means the fold really did overwrite a config and a prior value is owed back,
/// so a missing capture can only be a misaligned projection — refuse. `false` means the
/// node is absent, or the Configure was a wrong-kind fold no-op (`fold_configure`
/// ignores it, T-39-FOLD-PANIC) with genuinely nothing to invert — skip, exactly as
/// before. That `false` branch is what stops the capture-miss guard from degenerating
/// into a blanket "no capture -> reject", which would break the shipped, deliberately
/// resolve-only-gated wrong-kind Configure path.
///
/// # This is a `matches!`, so a new config variant does NOT fail to compile here (63-04)
/// It silently answers `false`, which routes a real capture miss to "skip" instead of
/// "refuse" — the user spends an undo step and gets nothing back, with no message. That
/// is exactly the defect T-51H-03 fixed for the other three variants, so the list below
/// must name EVERY variant of `MachineConfig` and must never gain a catch-all arm.
/// SEVEN variants, seven pairs. Plan 72-06 handed this function to plan 72-07 BY NAME for
/// exactly this reason: 72-07 appends `MachineConfig::Endpoint`, the compiler says
/// nothing about it here, and the sixth pair below is the whole of the fix. Plan 76-02
/// appended `MachineConfig::Label` and the seventh pair. MEASURED: with the pair removed
/// alone, a forged capture miss on a live label (`label.rs`
/// `a_label_capture_miss_on_a_live_label_is_refused`) was skipped and `Undo` returned Ok,
/// dropping the config restore; the ordinary undo legs stay green without it, because they
/// never miss once `prior_config_of` has its Label arm.
fn config_variant_matches_live_kind(pred: &Core, id: NodeId, config: &MachineConfig) -> bool {
    matches!(
        (config, pred.state.node(id)),
        (MachineConfig::Factory { .. }, Some(Node::Factory(_)))
            | (MachineConfig::Sink { .. }, Some(Node::Sink(_)))
            | (MachineConfig::Source { .. }, Some(Node::Source(_)))
            | (MachineConfig::Belt { .. }, Some(Node::Belt(_)))
            | (MachineConfig::Router { .. }, Some(Node::Router(_)))
            | (MachineConfig::Endpoint { .. }, Some(Node::Endpoint(_)))
            | (MachineConfig::Label { .. }, Some(Node::Label(_)))
    )
}

/// THE ONE WALK over a Delete capture's cascade belts that pairs each with the belt id its
/// re-mint produced (plan 88-02, WINDOWS 228, D-04).
///
/// A captured belt with EMPTY geometry is skipped and does NOT advance the minted-id cursor:
/// the undo group `compute_inverse` writes re-draws only a belt with tiles, so the fold mints
/// exactly one id per non-empty capture, in capture order. `mint` is asked for the id of each
/// belt the walk keeps, in that order, and a `None` from it pairs nothing.
///
/// # Why one helper
/// `compute_inverse` (which WRITES the undo group, minting through the prediction fold) and
/// `reconstruct_projection`'s Undo arm (which REBUILDS the re-mint table from the folded group's
/// minted ids) must walk the capture the same way. Until plan 88-02 the projection paired
/// `captured.belts[idx]` with `group_placed[idx + 1]` for EVERY captured belt while the inverse
/// skipped an empty one, so on a capture `[empty, real]` the real belt was paired with an id
/// that does not exist and its re-mint entry was never written: a later step naming the real
/// belt then named its ORIGINAL id (`undo_remint_pairs_by_identity.rs`). Both now call this
/// function, so the skip predicate exists once and the two cannot drift apart again.
///
/// # Errors
/// Whatever `mint` returns, unchanged, at the first belt it refuses.
fn pair_captured_belts_with_minted(
    belts: &[DeletedBelt],
    mut mint: impl FnMut(&DeletedBelt) -> Result<Option<NodeId>, CommandError>,
) -> Result<Vec<(&DeletedBelt, NodeId)>, CommandError> {
    let mut pairs = Vec::with_capacity(belts.len());
    for belt in belts {
        if belt.geometry.is_empty() {
            continue;
        }
        if let Some(minted) = mint(belt)? {
            pairs.push((belt, minted));
        }
    }
    Ok(pairs)
}

/// Identify a cascade-removed belt's own [`NodeId`] from its captured incident links and
/// the deleted machine's id (12-05), or `None` when the links cannot name one.
///
/// The belt is the endpoint common to ALL of its links; for a single-link (one-ended dock)
/// belt it is simply the non-machine endpoint. Total + panic-free.
///
/// # The BELT-TO-BELT case, and why the count is the whole answer (74-03, LINK-07)
/// Since phase 74 a captured cascade link can name a belt at BOTH ends - `(b, 0) -> (c, 0)`
/// where `c` is the belt the delete took and `b` is the neighbour it left standing - and
/// nothing in that one tuple says which is which. The count settles it without appealing
/// to the tie-break: a cascade belt is in the cascade BECAUSE it carries a link to the
/// deleted machine ([`GridState::cascade_neighbours`](fabrico_core::state::GridState) is a
/// one-hop query over exactly those links), and it appears in EVERY link of its own record.
/// So its count is the record's length, strictly greater than any other endpoint's - except
/// the machine's, when the belt is docked to the same machine at both ends, and the
/// `id != machine` tie-break is written for that one case and no other.
///
/// # `None` is a REFUSAL, and it replaced a silent rename (threat T-74-14)
/// This used to fall back to returning `machine` for a link list that named no belt,
/// "never reached in practice". A forged or corrupted capture reaches it - the public
/// [`GridSession::replay`] primitive is the documented route, the same one
/// `undo_restores_every_link.rs` uses - and the fallback was not inert. MEASURED before the
/// fix: an emptied `DeletedBelt.links` made this answer `machine`, the caller then wrote
/// `machine -> <the re-minted BELT>` over the entry naming the re-minted MACHINE, and
/// `apply(Undo)` returned `Ok(())`. From there every gesture aimed at that machine resolved
/// to a belt, with nothing said to anyone. A board that quietly becomes a different board
/// is the outcome this milestone refuses outright, so the answer is now a typed non-answer
/// and each caller says what it does with one.
fn identify_belt(links: &[(NodeId, PortId, NodeId, PortId)], machine: NodeId) -> Option<NodeId> {
    if links.is_empty() {
        return None;
    }
    if links.len() == 1 {
        let (f, _, t, _) = links[0];
        let belt = if f == machine { t } else { f };
        return (belt != machine).then_some(belt);
    }
    let mut counts: BTreeMap<NodeId, usize> = BTreeMap::new();
    for &(f, _, t, _) in links {
        *counts.entry(f).or_default() += 1;
        if t != f {
            *counts.entry(t).or_default() += 1;
        }
    }
    // The belt appears in every link → highest count; tie-break prefers a non-machine id.
    counts
        .into_iter()
        .max_by_key(|&(id, c)| (c, id != machine))
        .map(|(id, _)| id)
        .filter(|&id| id != machine)
}

/// The re-`Dock` records a DELETED NODE'S OWN capture owes, resolved into
/// `(endpoint, machine_node, machine_port)` triples in the capture's own order (73-05,
/// UNDO-02 / UNDO-03).
///
/// `node` is the deleted node's id, taken from [`EditOp::Delete`]'s own `node` field. That
/// is ruling R-20 and it is the entire reason [`DeletedSelf`] needs no id of its own:
/// [`identify_belt`] would infer the WRONG id here, silently, because a self-record's links
/// name the deleted node itself as one endpoint and the docked MACHINE as the other, and
/// `identify_belt` is written to return the endpoint that is NOT the id it is handed.
///
/// # The direction rule, taken from the cascade belt leg verbatim
/// The node as link SOURCE is [`BeltEnd::Head`] (LOAD) and the node as link TARGET is
/// [`BeltEnd::Tail`] (OFFLOAD) - `fold_dock`'s two arms, read backwards. It applies to a
/// wire unchanged, because a `Dock` aimed at a wire folds through exactly the same code.
///
/// # Returns `Result` because the wire arm can refuse
/// A capture that names links but no restorable shape is malformed, and a malformed
/// capture is refused BEFORE any mutation rather than silently emitting fewer records than
/// the delete tore down. A silently-short restore is the defect this phase exists to close:
/// an undo that reports success and hands back a different board.
fn self_record_links(
    self_record: &Option<DeletedSelf>,
    node: NodeId,
) -> Result<Vec<(BeltEnd, NodeId, PortId)>, CommandError> {
    match self_record {
        // A belt's own links are ALL of them: `fold_draw_belt` writes no link at all, so
        // there is nothing for the re-draw to already own and nothing to skip.
        Some(DeletedSelf::Belt(b)) => Ok(dock_legs(&b.links, node, None)),
        // A wire's re-`DrawWire` re-writes the canonical `(wire, 0) -> to` link for
        // itself, so that ONE link is skipped and every other is replayed. The wire's id
        // is `node` here - the `Delete` record's own field - so unlike the cascade case
        // below nothing has to be derived and nothing can be refused.
        Some(DeletedSelf::Wire(w)) => Ok(dock_legs(&w.links, node, Some(w.to))),
        None => Ok(Vec::new()),
    }
}

/// The rot-0 box and anchor a node holds NOW, as the [`BoxRestore`] an `AddPort` inverse
/// puts back (plan 74.1-16), or `None` when the node has no cell (absent, or a cell-less
/// `Wire`-minted belt, where `fold_add_port` is a no-op). An absent footprint entry is the
/// `1x1 rot0` convention.
///
/// ONE function for the TWO capture sites, `capture_before_fold` on the real core and
/// `reconstruct_projection` on the throwaway re-fold, for the reason
/// [`router_table_of`] states: an undo must behave the same before and after a save.
fn box_of(core: &Core, node: NodeId) -> Option<BoxRestore> {
    let (anchor_x, anchor_y) = core.state.cell_of(node)?;
    let fp = core.state.footprint_of(node).unwrap_or(Footprint { w: 1, h: 1, rot: 0 });
    Some(BoxRestore { w: fp.w, h: fp.h, anchor_x, anchor_y })
}

/// The `MachineConfig::Router` a node currently holds, or `None` when it is not a live
/// Router (73-12, 73-REVIEW CR-01).
///
/// # ONE function because there are TWO capture sites and they must not drift
/// `capture_before_fold` reads it off the REAL core before a `RemovePort` folds;
/// `reconstruct_projection` reads it off the throwaway `fresh` core before the same
/// record folds on the re-fold walk. Those two are the live session and the post-load
/// rebuild, and a `RemovePort` undo that behaved differently before and after a save is
/// exactly the defect `configure.rs`'s save-load leg exists to catch. The `Configure`
/// arms beside them are written out twice by hand and carry a note saying they are one
/// rule written twice; this one is one rule written ONCE, which is the shape 67-REVIEW
/// WR-04 merged `attribute_severances` into.
///
/// `faults` is deliberately NOT captured, matching the `Configure` arms: the inverse
/// restores CONFIGURATION, not a snapshot-captured debug counter, and `fold_configure`
/// leaves the counter alone in both directions.
fn router_table_of(core: &Core, node: NodeId) -> Option<MachineConfig> {
    match core.state.node(node) {
        Some(Node::Router(r)) => Some(MachineConfig::Router {
            routes: r.routes.clone(),
            default: r.default,
        }),
        _ => None,
    }
}

/// The PRIOR effective config a `Configure` carrying `config` overwrites on `node`, read
/// off `core`, or `None` when the node is absent or of the wrong kind (a fold no-op with
/// nothing to invert, threat T-39-FOLD-PANIC). `Source` alone reads `source_trigger`,
/// because a Source config is a core no-op with no state to read (default Webhook).
///
/// ONE function for the two capture sites (plan 74.1-23). Until then this six-arm match
/// was written out twice by hand, in `capture_before_fold` and in
/// `reconstruct_projection`, each carrying a note that the two were one rule and that an
/// undo of a Configure would behave differently before and after a save if they drifted.
/// `faults` is deliberately not captured (see [`router_table_of`]).
fn prior_config_of(
    core: &Core,
    node: NodeId,
    config: &MachineConfig,
    source_trigger: impl Fn(NodeId) -> SourceTrigger,
) -> Option<MachineConfig> {
    let live = core.state.node(node);
    Some(match config {
        MachineConfig::Factory { .. } => match live {
            Some(Node::Factory(f)) => MachineConfig::Factory { source: f.source.clone() },
            _ => return None,
        },
        MachineConfig::Sink { .. } => match live {
            Some(Node::Sink(s)) => MachineConfig::Sink { target: s.template.clone() },
            _ => return None,
        },
        MachineConfig::Source { .. } => MachineConfig::Source { trigger: source_trigger(node) },
        // 63-04: Belt and Router read the LIVE NODE like Factory and Sink, NOT a side map
        // like Source (an inviting wrong template: both fields are on the node).
        MachineConfig::Belt { .. } => match live {
            Some(Node::Belt(b)) => MachineConfig::Belt { ticks_per_slot: b.ticks_per_slot },
            _ => return None,
        },
        MachineConfig::Router { .. } => match live {
            Some(Node::Router(r)) => {
                MachineConfig::Router { routes: r.routes.clone(), default: r.default }
            }
            _ => return None,
        },
        // 72-07 (SERVE-08): the Route's prior path, a serialized field on the node.
        MachineConfig::Endpoint { .. } => match live {
            Some(Node::Endpoint(e)) => MachineConfig::Endpoint { path: e.path.clone() },
            _ => return None,
        },
        // 76-02 (D-04): a label's prior words, colour AND box, read off the live node and
        // its `footprints` entry (absent means the 1x1 rot-0 default). All three, because
        // one Apply writes all three and one Undo must put all three back.
        MachineConfig::Label { .. } => match live {
            Some(Node::Label(l)) => {
                let fp = core.state.footprint_of(node).unwrap_or(Footprint { w: 1, h: 1, rot: 0 });
                MachineConfig::Label { text: l.text.clone(), colour: l.colour, w: fp.w, h: fp.h }
            }
            _ => return None,
        },
    })
}

/// The WHOLE config `node` carries on `core`, keyed by the node's own kind, or `None`
/// for an absent node and for the four kinds that carry none (Tee, Balancer, Merge,
/// Wire). Plan 86-03 (WORK-01, D-01): the Delete capture, so an undo of a Delete gives a
/// machine back with its JS, target, trigger, pace, rules, path or words.
///
/// [`prior_config_of`] answers a different question (the prior value of the field ONE
/// incoming Configure overwrites, so it is keyed by that config's variant). This one has
/// no incoming config to key on, so it matches the node, and it does so EXHAUSTIVELY with
/// no catch-all arm: a future `Node` variant fails to compile here instead of quietly
/// coming back from an undo at its defaults. The per-kind readers are `prior_config_of`'s,
/// copied, so the two captures read the same fields (a Handler is a `Node::Factory`; a
/// Router's `faults` is deliberately not captured, see [`router_table_of`]).
///
/// `source_trigger` is the running Source-trigger map read, because a Source config is a
/// core no-op with no state to read (default Webhook).
fn config_of_node(
    core: &Core,
    node: NodeId,
    source_trigger: impl Fn(NodeId) -> SourceTrigger,
) -> Option<MachineConfig> {
    Some(match core.state.node(node)? {
        Node::Factory(f) => MachineConfig::Factory { source: f.source.clone() },
        Node::Sink(s) => MachineConfig::Sink { target: s.template.clone() },
        Node::Source(_) => MachineConfig::Source { trigger: source_trigger(node) },
        Node::Belt(b) => MachineConfig::Belt { ticks_per_slot: b.ticks_per_slot },
        Node::Router(r) => MachineConfig::Router { routes: r.routes.clone(), default: r.default },
        Node::Endpoint(e) => MachineConfig::Endpoint { path: e.path.clone() },
        Node::Label(l) => {
            let fp = core.state.footprint_of(node).unwrap_or(Footprint { w: 1, h: 1, rot: 0 });
            MachineConfig::Label { text: l.text.clone(), colour: l.colour, w: fp.w, h: fp.h }
        }
        Node::Tee(_) | Node::Balancer(_) | Node::Merge(_) | Node::Wire(_) => return None,
    })
}

/// The undo captures one fold slice owes, each keyed by its record's
/// `(action, sequence)`: the box an `AddPort` grows from, the port (and slot) a
/// `RemovePort` takes plus the Router table it re-points, the prior config a
/// `Configure` overwrites, and (76-05, generalised in 86-03, D-01) the whole config of
/// any node a `Delete` removes.
#[derive(Default)]
struct SliceCaptures {
    added_port_boxes: Vec<((u64, u64), BoxRestore)>,
    removed_ports: Vec<((u64, u64), (Port, PortId))>,
    prior_configs: Vec<((u64, u64), MachineConfig)>,
}

/// The node an `AddPort`, `RemovePort`, `Configure` or `Delete` edits: the four records
/// whose undo capture is a PRIOR STATE of that node.
///
/// `Delete` joined in 76-05 (D-08, research Pitfall 8): a deleted node's config is
/// captured before it goes (a label's alone until plan 86-03, every configurable kind
/// since), so a `Configure` then a `Delete` of one node in one drain pass names the node
/// twice and the Delete is captured against the core the Configure already advanced.
/// Without it the capture read the pre-batch node and the undo restored the config the
/// user had just replaced.
fn captured_edit_node(op: &EditOp) -> Option<NodeId> {
    match op {
        EditOp::AddPort { node, .. }
        | EditOp::RemovePort { node, .. }
        | EditOp::Configure { node, .. }
        | EditOp::Delete { node, .. } => Some(*node),
        _ => None,
    }
}

/// Capture `records` (ONE fold slice) against `core` as it stands BEFORE the slice
/// folds. ONE helper for the two capture sites, [`GridSession::capture_before_fold`] on
/// the real core and `reconstruct_projection`'s slice loop on the throwaway re-fold, so
/// an undo behaves the same before and after a save (plan 74.1-23, review WR-01).
///
/// # Per record when a node is named twice
/// A capture must see the state the RECORD folds against, not the state the BATCH folds
/// against. Those are the same unless two records in the slice edit the same node:
/// `GridSession::apply` folds one record per tick, but `fold_live` folds a whole drain
/// pass (two same-tick growing `AddPort`s on one node both captured the pre-batch 3x3
/// box, so the second one's undo restored 3x3 instead of 3x4, left an Out at row 3, and
/// the save then failed `PortOutOfFootprint`; a second same-tick `RemovePort` or
/// `Configure` captured the wrong port or config the same way; since 76-05 a `Configure`
/// then a `Delete` of one label would capture the words the Configure replaced). So when
/// two or more `AddPort` / `RemovePort` / `Configure` / `Delete` records name one node
/// ([`captured_edit_node`]), each record is captured
/// against a SCRATCH clone of `core` advanced by the slice's earlier records one at a
/// time with the core's own fold, its commands and tick discarded. Otherwise every
/// record is read off `core` itself, the single read every capture took before, byte for
/// byte.
///
/// `source_triggers` is the running Source-trigger map BEFORE the slice; it is advanced
/// record by record inside the slice on a local overlay (the caller still advances its
/// own map after the fold, as before).
///
/// Bounds-safe throughout: a forged out-of-range `RemovePort.index` reads `None` and
/// skips (threat T-36-06); a wrong-kind or absent node skips (T-39-FOLD-PANIC).
fn capture_slice(
    core: &Core,
    records: &[EditRecord],
    source_triggers: &BTreeMap<NodeId, SourceTrigger>,
) -> SliceCaptures {
    let mut seen: Vec<NodeId> = Vec::new();
    let names_a_node_twice = records.iter().filter_map(|r| captured_edit_node(&r.op)).any(|n| {
        let twice = seen.contains(&n);
        seen.push(n);
        twice
    });
    let mut scratch: Option<Core> = names_a_node_twice.then(|| core.clone());
    let mut slice_triggers: BTreeMap<NodeId, SourceTrigger> = BTreeMap::new();
    let mut out = SliceCaptures::default();
    for (i, r) in records.iter().enumerate() {
        let at: &Core = scratch.as_ref().unwrap_or(core);
        let key = (r.action, r.sequence);
        // The trigger in force just before this record: the slice overlay first (a
        // `Configure{Source}` earlier in this slice), then the running map, then the
        // Webhook default. ONE closure for the Configure and the Delete arm, so a
        // Configure{Source} then a Delete of that Source in one pass captures the Timer
        // the Configure just set (86-03).
        let trigger = |n: NodeId| {
            slice_triggers
                .get(&n)
                .or_else(|| source_triggers.get(&n))
                .cloned()
                .unwrap_or(SourceTrigger::Webhook)
        };
        match &r.op {
            // 74.1-16: the box and anchor the add grows FROM.
            EditOp::AddPort { node, .. } => {
                if let Some(captured) = box_of(at, *node) {
                    out.added_port_boxes.push((key, captured));
                }
            }
            EditOp::RemovePort { node, index, .. } => {
                // 73-03: the SLOT rides with the port, so the inverse puts it back where
                // it was rather than last.
                if let Some(port) =
                    at.state.ports_of(*node).and_then(|ps| ps.get(usize::from(*index))).copied()
                {
                    out.removed_ports.push((key, (port, *index)));
                }
                // 73-12 (73-REVIEW CR-01): the ROUTING TABLE the removal re-points,
                // through the same `prior_configs` seam a `Configure` uses.
                if let Some(prior) = router_table_of(at, *node) {
                    out.prior_configs.push((key, prior));
                }
            }
            EditOp::Configure { node, config, .. } => {
                if let Some(prior) = prior_config_of(at, *node, config, trigger) {
                    out.prior_configs.push((key, prior));
                }
            }
            // 76-05 (D-08), generalised by 86-03 (WORK-01, D-01): a deleted node's WHOLE
            // config ([`config_of_node`]: a Factory or Handler's JS, a Sink's target, a
            // Source's trigger, a belt's pace, a Router's rules, a Route's path, a label's
            // words, colour and box), through the same `prior_configs` seam, keyed by the
            // Delete record. `DeletedSubgraph` carries the box and ports but no config, and
            // growing it would take an EDIT bump for state the node already holds; this
            // capture is never serialized and is rebuilt by the re-fold after a load (the
            // live twin wins where both exist). The Delete inverse re-applies it.
            EditOp::Delete { node, .. } => {
                if let Some(config) = config_of_node(at, *node, trigger) {
                    out.prior_configs.push((key, config));
                }
            }
            _ => {}
        }
        if let EditOp::Configure { node, config: MachineConfig::Source { trigger }, .. } = &r.op {
            slice_triggers.insert(*node, trigger.clone());
        }
        if let Some(core) = scratch.as_mut()
            && i + 1 < records.len()
        {
            let _discarded = core.advance_edits(std::slice::from_ref(r), &[]);
        }
    }
    out
}

/// The re-`Dock` records a CASCADE-removed wire owes: every captured link except the
/// canonical `(wire, 0) -> to` one [`fold_draw_wire`] re-writes for itself (73-05,
/// UNDO-03, ruling R-24).
///
/// # Why the canonical link is SKIPPED rather than replayed
/// Re-writing it would not corrupt anything - `GridState::link` would overwrite the same
/// key with the same value - but it would make a set-equality assertion pass for the WRONG
/// REASON. A leg that blindly replayed every captured link is indistinguishable, on any
/// board, from one that knows which link the fold already owns; skipping is what makes the
/// difference observable, and observability is the entire point of this phase.
///
/// # Why the wire's own id has to be DERIVED here
/// [`DeletedWire`] carries no id field - a cascade record describes a wire that was
/// removed alongside the machine and the machine's id is the only one the `Delete` record
/// names. The wire is recoverable from the capture itself: the canonical link's SOURCE is
/// the wire, because the link's target `(node, port)` equals `wire.to`, which by
/// construction names a MACHINE and never the wire. Every link in the list is incident to
/// the wire, so a link whose target is not the wire must have the wire as its source.
///
/// # A capture with links but no canonical one is REFUSED
/// No live board produces it: `fold_draw_wire` writes that link at mint time and only a
/// forged `Dock { endpoint: Head }` aimed at the same wire could overwrite the `(wire, 0)`
/// key afterwards. Such a capture cannot be replayed faithfully - the wire's id is not
/// recoverable from it - and the group is therefore refused BEFORE any mutation, the same
/// typed shape every other structural refusal in this function uses. Emitting fewer
/// records than the delete tore down and returning `Ok` is the exact defect UNDO-03
/// closes, so the alternative here is not "skip quietly", it is "refuse".
fn non_canonical_wire_links(
    wire: &DeletedWire,
) -> Result<Vec<(BeltEnd, NodeId, PortId)>, CommandError> {
    if wire.links.is_empty() {
        return Ok(Vec::new());
    }
    let Some(wire_orig) = wire
        .links
        .iter()
        .find_map(|&(fnode, fport, tnode, tport)| {
            (fport == 0 && (tnode, tport) == wire.to).then_some(fnode)
        })
    else {
        return Err(CommandError::UndoDoesNotFit);
    };
    Ok(dock_legs(&wire.links, wire_orig, Some(wire.to)))
}

/// Resolve captured links into `(endpoint, machine_node, machine_port)` re-`Dock` triples,
/// in the capture's own order, skipping `canonical` when it is given.
///
/// The direction rule is the cascade belt leg's, verbatim, and it is the inverse of
/// `fold_dock`'s two arms: the node as link SOURCE is [`BeltEnd::Head`] (LOAD, the fold
/// writes `link((belt, 0), (node, port))`), and the node as link TARGET is
/// [`BeltEnd::Tail`] (OFFLOAD, the fold writes `link((node, port), (belt, 0))`). It
/// applies to a wire unchanged, because a `Dock` aimed at a wire folds through exactly
/// the same two arms.
///
/// `canonical` is the `(node, port)` a `DrawWire` re-writes for itself out of the node's
/// port 0. `None` for a belt, whose re-draw writes no link at all.
fn dock_legs(
    links: &[(NodeId, PortId, NodeId, PortId)],
    node: NodeId,
    canonical: Option<(NodeId, PortId)>,
) -> Vec<(BeltEnd, NodeId, PortId)> {
    links
        .iter()
        .filter(|&&(fnode, fport, tnode, tport)| {
            !(fnode == node && fport == 0 && canonical == Some((tnode, tport)))
        })
        .map(|&(fnode, fport, tnode, tport)| {
            if fnode == node {
                (BeltEnd::Head, tnode, tport)
            } else {
                (BeltEnd::Tail, fnode, fport)
            }
        })
        .collect()
}

/// The core [`Role`] a catalog/wire role byte denotes (`In=0`, `Out=1`, `Fault=2`) —
/// the inverse of [`catalog_role_u8`]. `None` for an unknown byte (a malformed
/// `AddPort` command), so a forged role reject is typed, never a silent mis-cast.
#[must_use]
fn role_from_u8(b: u8) -> Option<Role> {
    match b {
        port_role::IN => Some(Role::In),
        port_role::OUT => Some(Role::Out),
        port_role::FAULT => Some(Role::Fault),
        _ => None,
    }
}

/// The core [`Medium`] a wire medium byte denotes (`Mechanical=0`, `Electrical=1`) —
/// the inverse of [`catalog_medium_u8`]. `None` for an unknown byte (a malformed
/// `AddPort` command). `Electrical` is the first design-time WIRE port (PORT-06).
#[must_use]
fn medium_from_u8(b: u8) -> Option<Medium> {
    match b {
        port_medium::MECHANICAL => Some(Medium::Mechanical),
        port_medium::ELECTRICAL => Some(Medium::Electrical),
        _ => None,
    }
}

/// Whether a carrier of medium `a` may dock/connect to a port of medium `b` (PORT-08)
/// — the SINGLE, SHARED type-compatibility rule. Currently pure equality (a Mechanical
/// belt docks a Mechanical port; a wire connects a wire port; cross-medium is rejected),
/// but factored as one predicate so BOTH directions apply the identical rule: the Dock
/// belt->port gate calls it, and (Phase 63, WIRE-01) the `DrawWire` arm calls the SAME
/// function for the wire->port direction, on BOTH of the wire's endpoints. Pure,
/// `Copy`-in/`bool`-out, no allocation — cheap to call in the validation hot path.
///
/// There is exactly ONE definition of this rule and there must stay exactly one: two
/// copies is how the Dock and DrawWire accept-envelopes silently diverge (T-63-14).
#[must_use]
fn mediums_compatible(a: Medium, b: Medium) -> bool {
    a == b
}

/// Whether `id` names a live label (phase 76, plan 76-04, SHAPE-14, D-07).
///
/// Read by the `Dock`, `DrawWire` and `AddPort` arms as their FIRST check after the
/// handles resolve, so a label is refused as [`CommandError::LabelDoesNotConnect`] before
/// any port, role, geometry or occupancy check runs. The order is the point: `Dock`'s
/// non-spatial `FAULT_PORT` branch skips ALL geometry (WINDOWS 68), so a kind check placed
/// after it would never be reached for that branch, and until this check a belt anywhere
/// on the board was linked to a note there. One helper, three readers, so the three arms
/// cannot disagree about what a label is.
#[must_use]
fn is_label<V: GridLookup>(view: &V, id: NodeId) -> bool {
    view.kind_of(id) == Some(machine_kind::LABEL)
}

/// Resolve a wire-level machine port index into the node's SPATIAL catalog index, or
/// `None` for the NON-spatial [`FAULT_PORT`] exemption.
///
/// `port == FAULT_PORT` addresses the reserved logical fault sentinel. When the node
/// declares a real `Role::Fault` nub, the sentinel resolves to that nub's catalog
/// index and the caller runs the FULL spatial validation on it, exactly as if the
/// client had addressed the nub by index (the 20-review WR-03 node-aware exemption).
/// A node with no fault nub (or no ports at all) keeps the non-spatial exemption and
/// yields `None`.
///
/// Shared by the `Dock` and `Unlink` arms (63-05). One definition: an unlink that
/// resolved the sentinel differently from the dock that created the link would name a
/// different port and remove nothing.
#[must_use]
fn resolve_spatial_port(ports: Option<&[Port]>, port: PortId) -> Option<PortId> {
    if port != FAULT_PORT {
        return Some(port);
    }
    ports
        .and_then(|ports| ports.iter().position(|p| p.role == Role::Fault))
        .and_then(|idx| PortId::try_from(idx).ok())
}

/// Translate a resolved SPATIAL catalog index into the LINK KEY `fold_dock` writes.
///
/// LIVE-02/LIVE-05 (RESEARCH Finding 1): machines emit on ROUTING port ids —
/// `factory.rs` pushes its outbox on the JS-visible port (default `ctx.emit(0, ..)`),
/// `tee.rs` calls `push_output(0..outputs)`, the router's `fold_place` default route
/// is 0 — while the command wire addresses ports by their CATALOG array index (FACTORY
/// Out = 1, TEE Outs = 1/2). The frozen link key MUST live in the emit keyspace or
/// every item a docked Out emits vanishes at the missing link.
///
/// - `Role::Fault` → the reserved [`FAULT_PORT`] sentinel, so the dock key equals the
///   fault-emit key and a docked fault belt actually receives faulted items (Option A).
/// - `Role::Out` → the port's 0-based position among the node's `Role::Out` ports.
/// - `Role::In` (and an index naming no declared port) → unchanged: In ports come
///   FIRST in every catalog entry, so Head/In keys are already aligned.
///
/// `dock_still_reaches` (state.rs) carries the mirror REVERSE map for the rotate
/// keep-or-unlink predicate.
///
/// # Two keyspaces that genuinely collide
/// A ROUTER declares [In (catalog 0), Out (catalog 1)] and its Out's routing key is 0,
/// so catalog index 0 and the live Out link key are the SAME number. That is why the
/// callers apply the direction rule (`Head` → `In`, `Tail` → `Out`/`Fault`) BEFORE
/// translating, rather than carrying an ambiguous index through.
#[must_use]
fn dock_link_key(ports: &[Port], idx: PortId) -> PortId {
    match ports.get(idx as usize).map(|p| p.role) {
        Some(Role::Fault) => FAULT_PORT,
        Some(Role::Out) => {
            let mut routing: PortId = 0;
            for p in &ports[..idx as usize] {
                if p.role == Role::Out {
                    routing += 1;
                }
            }
            routing
        }
        _ => idx,
    }
}

/// The rot-0 [`Port`] a dock link key names on a machine whose port list is `ports`, for a
/// dock at the belt's `endpoint`: the command-layer read of the core's one link-key resolver
/// (`GridState::resolve_link_port`, which is crate-private), the mirror of [`dock_link_key`].
///
/// `FAULT_PORT` names the first `Role::Fault` port; a `Tail` (offload) key is an Out routing
/// key, the n-th `Role::Out` port; a `Head` (load) key is the raw catalog index. `None` when
/// nothing answers, which the caller reads as "this dock cannot reach".
fn link_key_port(ports: &[Port], key: PortId, endpoint: BeltEnd) -> Option<Port> {
    if key == FAULT_PORT {
        return ports.iter().find(|p| p.role == Role::Fault).copied();
    }
    match endpoint {
        BeltEnd::Tail => ports.iter().filter(|p| p.role == Role::Out).nth(usize::from(key)).copied(),
        BeltEnd::Head => ports.get(usize::from(key)).copied(),
    }
}

/// Does `port`, on a machine anchored at `anchor` with footprint `w` by `h` at rotation
/// `rot`, meet the belt end `(end_cell, outward)` by the Dock arm's machine rules? The
/// doorstep rule (the port's world cell stepped toward its side lands EXACTLY on the end
/// cell) and the narrowed facing term (refused only when the belt's outward side EQUALS the
/// port side, phase 74.1 D-02). It is the geometry `GridState::dock_still_reaches` judges a
/// kept dock by on every turn, so a dock this predicate accepts at a rotation is one the fold
/// keeps at that rotation.
fn port_meets_end(
    anchor: (i32, i32),
    w: u16,
    h: u16,
    rot: u8,
    port: &Port,
    (end_cell, outward): ((i32, i32), Option<Side>),
) -> bool {
    let (pcell, pside) = port_world(anchor, w, h, rot, port);
    let (dx, dy) = unit_delta(pside);
    (pcell.0 + dx, pcell.1 + dy) == end_cell && outward != Some(pside)
}

/// THE DOCKS A TURN MAKES (phase 89, D-08, BELT-07, SEED-006's reconnect half): one
/// [`EditOp::Dock`] for every loose belt end that a port of `node` faces once the node sits
/// at `new_rot`, with a matching role. EMPTY for a turn that faces no such end, which is what
/// keeps such a turn's group the one bare `Rotate` it always was (research Pitfall 4).
///
/// # The rule, and why it lives here
/// The fold only ever cuts on a turn: `rotate_footprint` keeps a dock whose port still faces
/// its belt end and releases every other one, and it never links. So a machine turned away
/// from a belt and back left the belt facing the port with nothing joining them, and so did a
/// machine turned toward any loose end (a design decision: a machine turned toward a loose
/// belt end connects, not only one it let go of). The joins are therefore made HERE, in the
/// validate arm both producers fold (research Finding B), as ordinary logged `Dock` records
/// in the turn's own group: one action id, so one Undo reverts the turn and every dock it
/// made, and a replay folds them verbatim with no new rule in the core.
///
/// # Each Dock is one the Dock arm itself would accept, after the turn
/// For each port, in catalog order: an `In` takes a belt's Head, an `Out` or `Fault` takes a
/// Tail (the Dock arm's `role_ok`); the port's medium must take a Mechanical carrier
/// ([`mediums_compatible`]); a DRAWN belt must own the port's doorstep cell, and its matching
/// end must sit on that cell with its outward side not the port side ([`port_meets_end`], the
/// doorstep rule and the narrowed facing term); the link key is [`dock_link_key`]'s.
///
/// # What a turn never does (D-08, Pitfall 2)
/// - It never joins an end that still holds a dock after the turn: a Head's one dock, or ANY
///   dock into a Tail, so a turn never silently joins an existing fan-in. A dock into this
///   node counts as gone only when this turn releases it.
/// - It never docks a port that still holds a dock after the turn, nor a port any cable
///   touches: `fold_dock` links with a bare insert, so a second dock on a kept port would
///   REPLACE the link the user made (WINDOWS 128's shape).
///
/// "After the turn" is read through [`GridLookup::links_touching`], which answers from the
/// board the fold will see, and judged by [`port_meets_end`] at `new_rot`, the facing rule
/// the fold's own keep-or-release verdict applies. The fold still only severs; a dock made
/// here is a record, so it is undone and redone like any other.
fn turn_docks<V: GridLookup + ?Sized>(
    view: &V,
    node: NodeId,
    anchor: (i32, i32),
    foot: Footprint,
    new_rot: u8,
) -> Vec<EditOp> {
    let Some(ports) = view.ports_of(node) else {
        return Vec::new();
    };
    // The turned node's belt docks, each judged at `new_rot`: `(belt, end, key, kept)`.
    // A link with no drawn belt on its far side (a cable, a geometry-empty belt) is not a
    // spatial dock and is left out: a turn neither keeps nor frees anything through it.
    let mut docks: Vec<(NodeId, BeltEnd, PortId, bool)> = Vec::new();
    for (from, to) in view.links_touching(node) {
        let (belt, end, key) = if from.0 == node && to.1 == 0 {
            (to.0, BeltEnd::Tail, from.1)
        } else if to.0 == node && from.1 == 0 {
            (from.0, BeltEnd::Head, to.1)
        } else {
            continue;
        };
        let Some(geom) = view.belt_geometry(belt).filter(|g| !g.is_empty()) else {
            continue;
        };
        let kept = link_key_port(ports, key, end)
            .zip(belt_end_world(geom, end))
            .is_some_and(|(port, at)| port_meets_end(anchor, foot.w, foot.h, new_rot, &port, at));
        docks.push((belt, end, key, kept));
    }
    let mut out = Vec::new();
    for (index, port) in ports.iter().enumerate() {
        let Ok(index) = PortId::try_from(index) else {
            break;
        };
        let end = match port.role {
            Role::In => BeltEnd::Head,
            Role::Out | Role::Fault => BeltEnd::Tail,
        };
        if !mediums_compatible(Medium::Mechanical, port.medium) {
            continue;
        }
        // `FAULT_PORT` names the FIRST Fault only (`link_key_port`, `resolve_link_port`), and
        // every Fault maps to that one key: a later Fault docking through it would replace the
        // first Fault's link in the fold and be judged against the first Fault on the next
        // turn (review WR-A-02). Only the first Fault docks.
        if port.role == Role::Fault && ports.iter().position(|p| p.role == Role::Fault) != Some(usize::from(index)) {
            continue;
        }
        let key = dock_link_key(ports, index);
        // The PORT keeps a dock through this turn, or a cable is on it: leave it alone.
        if docks.iter().any(|&(_, e, k, kept)| kept && e == end && k == key)
            || view.wire_touches_port((node, index))
        {
            continue;
        }
        let (pcell, pside) = port_world(anchor, foot.w, foot.h, new_rot, port);
        let (dx, dy) = unit_delta(pside);
        let doorstep = (pcell.0 + dx, pcell.1 + dy);
        // The belt and its tiles from the board the fold will see (review CR-A-01, WR-A-01):
        // on a paused host pass that board holds a belt drawn earlier in the pass and has
        // dropped one an earlier Delete took with its machine, as the headless board does.
        let Some((belt, geom)) = view.fold_belt_at(doorstep).filter(|&(b, _)| b != node) else {
            continue;
        };
        let Some(at) = belt_end_world(geom, end) else {
            continue;
        };
        if !port_meets_end(anchor, foot.w, foot.h, new_rot, port, at) {
            continue;
        }
        // The END holds a dock after the turn unless every dock on it is one of this node's
        // that this turn releases. A belt-to-belt join on it holds it too.
        let held = view.links_touching(belt).into_iter().any(|(from, to)| {
            let partner = match end {
                BeltEnd::Head if from.0 == belt => to,
                BeltEnd::Tail if to.0 == belt => from,
                _ => return false,
            };
            !(partner.0 == node
                && docks.iter().any(|&(b, e, k, kept)| !kept && b == belt && e == end && k == partner.1))
        });
        // One dock per end per turn: two ports cannot share a doorstep, but say it. And one
        // dock per source key into a Tail, since the fold keys a link by its source.
        let already = out.iter().any(|op| {
            matches!(op, EditOp::Dock { belt: b, endpoint: e, .. } if *b == belt && *e == end)
                || matches!(op, EditOp::Dock { endpoint: BeltEnd::Tail, port: k, .. } if end == BeltEnd::Tail && *k == key)
        });
        if held || already {
            continue;
        }
        out.push(EditOp::Dock { belt, endpoint: end, node, port: key });
    }
    out
}

/// Validate + normalize a [`GridCommand`] against a read-only [`GridLookup`] view,
/// producing the RESOLVED [`EditRecord`] on accept (decision Q2) or a typed
/// [`CommandError`] on reject.
///
/// This is a **PURE** function: it reads the view and produces a record but NEVER
/// mutates topology and NEVER folds — the session does the fold (CMD-05). On ANY
/// reject it produces NOTHING (the byte-identical-state guarantee, SC#2) and never
/// panics (`view.resolve`/`view.kind_of` return `Option`, never index a missing
/// node — T-8-CMD-PANIC). Mirrors `input_apply::apply_gesture`.
///
/// The returned record carries only its RESOLVED [`EditOp`] and the current
/// `EDIT_SCHEMA_VERSION`; its `sequence`/`tick`/`action` provenance is stamped by
/// [`GridSession::apply`] (the tick-stamping discipline), so a standalone caller of
/// this function gets a placeholder-stamped record it is free to re-stamp.
///
/// # Errors
/// Returns the typed [`CommandError`] that fired: unknown-kind / out-of-bounds /
/// footprint-collision (Place), unknown-node / incompatible-ports / port-occupied /
/// invalid-dock (Wire), unknown-node (Delete).
/// Convert a wire [`fabrico_protocol::MachineConfig`] into the byte-identical core
/// [`MachineConfig`] the edit-log stores (CFG-01). The two enums are DELIBERATELY
/// separate types — the protocol owns the `TS`-derived wire shape (A3 wire-DTO-owner
/// discipline), the core owns the serialized edit-op shape — but their variant order is
/// LOAD-BEARING identical (Factory=0/Source=1/Sink=2/Belt=3/Router=4; Webhook=0/Timer=1;
/// Debug=0/Http=1; Get=0..Delete=4), so this is an allocation-preserving 1:1
/// remap (Strings and Vecs move, no clone). No blake3 is computed here (the fence).
/// `crates/fabrico-command/tests/machine_config_parity.rs` holds that variant-order
/// claim to account for all five pairs.
///
/// # It is a 1:1 remap but it is NOT total (63-04)
/// It was total until the `Belt` variant arrived. The core carries a belt's advance
/// interval as `NonZeroU32` and the wire carries a plain `u32` (the [`BeltView`]
/// precedent), so exactly one input has no image: a `ticks_per_slot` of zero. That is
/// REFUSED with [`CommandError::ZeroBeltInterval`] rather than defaulted — the type
/// exists to make zero unrepresentable, and `unwrap_or(DEFAULT_TICKS_PER_SLOT)` would
/// hand the user a belt running at a speed they never chose (threat T-63-24).
///
/// # Errors
/// [`CommandError::ZeroBeltInterval`] when a `Belt` config carries `ticks_per_slot: 0`,
/// and [`CommandError::PaceOutOfRange`] when it carries a non-zero value outside
/// [`BELT_PACE_RANGE`] (BELT-04). Both are WRITE-side refusals: nothing on the load or
/// replay path calls this function, which is what makes the range bound non-save-breaking
/// (`D-68-17`).
/// The inclusive `ticks_per_slot` range a `Configure{Belt}` may be WRITTEN with
/// (BELT-04, `D-68-01` as amended). 2 is the fast end - exactly half the measured
/// direction-ambiguity wall, and exactly `DEFAULT_TICKS_PER_SLOT` - and 20 is the chosen
/// slow floor. The full reasoning, including why the two ends carry different authority
/// and why this is a WRITE-side policy rather than a data invariant (`D-68-17`), is at
/// the check itself in [`wire_config_to_core`].
pub const BELT_PACE_RANGE: std::ops::RangeInclusive<u32> = 2..=20;

fn wire_config_to_core(
    config: fabrico_protocol::MachineConfig,
) -> Result<MachineConfig, CommandError> {
    use fabrico_protocol::{
        HttpMethod as WireMethod, MachineConfig as Wire, SinkTemplate as WireSink,
        SourceTrigger as WireTrigger,
    };
    Ok(match config {
        Wire::Factory { source } => MachineConfig::Factory { source },
        Wire::Source { trigger } => MachineConfig::Source {
            trigger: match trigger {
                WireTrigger::Webhook => SourceTrigger::Webhook,
                WireTrigger::Timer { interval_ticks } => SourceTrigger::Timer { interval_ticks },
            },
        },
        Wire::Sink { target } => MachineConfig::Sink {
            target: match target {
                WireSink::Debug => SinkTemplate::Debug,
                WireSink::Http { url, method } => SinkTemplate::Http {
                    url,
                    method: match method {
                        WireMethod::Get => HttpMethod::Get,
                        WireMethod::Post => HttpMethod::Post,
                        WireMethod::Put => HttpMethod::Put,
                        WireMethod::Patch => HttpMethod::Patch,
                        WireMethod::Delete => HttpMethod::Delete,
                    },
                },
            },
        },
        Wire::Belt { ticks_per_slot } => MachineConfig::Belt {
            // Two fallible steps, and they are DIFFERENT KINDS OF CHECK. Do not merge
            // them: each has its own tag because each sentence is true of its own cause
            // and false of the other's.
            //
            // (1) THE RANGE BOUND, `BELT_PACE_RANGE` (BELT-04, 68-04). Three claims,
            //     stated separately because `68-UI-SPEC.md` section 2 is explicit that
            //     they carry different authority:
            //
            //     THE FAST END IS A MEASURED ALIASING LIMIT, not a taste call. A dash
            //     pattern cannot convey motion faster than HALF ITS PERIOD per drawn
            //     step without becoming direction-ambiguous - a jump forward by half a
            //     period is indistinguishable from a jump backward by half a period. The
            //     belt tread's period is LOCKED at 16 world px
            //     (`frontend/src/render/synth/beltGeometry.ts`,
            //     `MARCH_NYQUIST_CEILING_PX_PER_TICK`, which CLAMPS to it rather than
            //     describing it), so the wall is 8 world px per sim tick. Slot pitch is
            //     8 world px (`CELL` 32 / `SLOTS_PER_TILE` 4), so px-per-tick is
            //     `8 / ticks_per_slot` and the wall is exactly `ticks_per_slot = 1`.
            //     Every pace offered to a user sits at or BELOW half the wall, which is
            //     `ticks_per_slot = 2` - which is `DEFAULT_TICKS_PER_SLOT`. So 2 is the
            //     FASTEST a user can select, and the control is slower-only. That is a
            //     consequence of the measurement, not a product decision.
            //
            //     THE SLOW END IS A CHOSEN FLOOR AND CARRIES NO MEASUREMENT AT ALL.
            //     Slower is always safe from aliasing, so 20 is simply how slow the
            //     shipped UI offers to go (`D-68-01`, as amended). It is stated
            //     separately so a reader does not inherit the fast end's authority for
            //     it.
            //
            //     IT IS THE FULL INCLUSIVE RANGE, NOT THE FIVE OFFERED STEPS. The panel
            //     offers {2, 4, 5, 10, 20} because those five divide 500 exactly and so
            //     label as whole px/sec figures; the BOUND is 2..=20, so a save written
            //     by a future UI with finer steps still loads (`D-68-02`). Narrowing
            //     this to the five would refuse fourteen paces a save can legitimately
            //     carry.
            //
            //     AND IT IS A WRITE-SIDE POLICY, NOT A DATA INVARIANT (`D-68-17`). It
            //     lives HERE, on the `GridCommand` -> `EditRecord` conversion, which
            //     nothing on the load or replay path calls: `run_log_two_logs` folds
            //     `EditRecord`s directly and `GridSession::replay` never reaches this
            //     function. So a log or a save carrying a `ticks_per_slot` outside
            //     `2..=20` still LOADS and still REPLAYS, which is the whole point -
            //     applying a UI range choice on load would make it a SAVE-BREAKING
            //     change and could reject a frozen golden or scenario fixture. The wrong
            //     answer here breaks saves silently, so it is pinned two ways:
            //     `a_log_carrying_an_out_of_range_pace_still_loads_and_replays_to_the_same_state`
            //     asserts the REPLAYED STATE (a load that substituted a default returns
            //     no error and produces a different board), and
            //     `every_frozen_corpus_pace_still_loads_and_replays` names the four
            //     values the frozen corpus uses.
            //
            //     Like the router target-port check above, it runs on the CONFIG's
            //     shape and not on the node's KIND: a Belt config aimed at a Router
            //     carrying an out-of-range pace is refused rather than accepted as a
            //     fold no-op, which is the settled reading of that arm's decision 1.
            //
            // (2) THE ZERO REFUSAL, unchanged. The core holds the interval as
            //     `NonZeroU32` so zero is UNREPRESENTABLE; a zero is refused rather than
            //     defaulted, because `unwrap_or(DEFAULT_TICKS_PER_SLOT)` would hand the
            //     user a working belt running at a speed they did not choose (T-63-24).
            //     It is checked SECOND so a zero keeps its own tag: the range bound
            //     starts at 2 and would otherwise swallow it, and
            //     `A belt needs a speed above zero.` is the sentence a user who left the
            //     field empty needs.
            ticks_per_slot: {
                if ticks_per_slot != 0 && !BELT_PACE_RANGE.contains(&ticks_per_slot) {
                    return Err(CommandError::PaceOutOfRange);
                }
                std::num::NonZeroU32::new(ticks_per_slot).ok_or(CommandError::ZeroBeltInterval)?
            },
        },
        Wire::Router { routes, default } => MachineConfig::Router {
            // The table moves VERBATIM: same order, no sort, no dedup. The router applies
            // the FIRST matching rule, so re-ordering here would silently change which
            // rule wins.
            routes: routes
                .into_iter()
                .map(|(key, port)| {
                    (
                        fabrico_core::state::RouteKey::new(key.offset, key.expect),
                        port,
                    )
                })
                .collect(),
            default,
        },
        // 72-07 (SERVE-08): the path moves VERBATIM. NO trimming, NO normalization, NO
        // leading-slash insertion. All four of R-47's rules are decided in the
        // `Configure` arm of `validate_normalize` below, where the LIVE BOARD is
        // reachable and rule 4 (uniqueness) can be asked at all; this function has only
        // the wire config and structurally cannot host the check that matters most.
        //
        // A slash is NOT inserted for a user who typed `orders`. Repairing input here
        // would mean the address the user sees in the field is not the address stored,
        // and the whole point of this field is that the two are the same string.
        Wire::Endpoint { path } => MachineConfig::Endpoint { path },
        // Phase 76 (plan 76-02): the CLOSED-SET CHECK for a label's colour. The wire
        // carries a plain `u8` and the core a six-variant `LabelColour`, so exactly the
        // bytes above 5 have no image here, and they are REFUSED as `UnknownOption` rather
        // than defaulted: `unwrap_or(Sand)` would paint a colour the user never chose
        // (the `ZeroBeltInterval` reasoning, T-76-07). The text and the size move
        // VERBATIM; their bounds need the board and live in the `Configure` arm below.
        Wire::Label { text, colour, w, h } => MachineConfig::Label {
            text,
            colour: fabrico_core::state::LabelColour::from_byte(colour)
                .ok_or(CommandError::UnknownOption)?,
            w,
            h,
        },
    })
}

/// THE ROUTE-AND-HANDLER PAIRING PREDICATE (D-04, ruling R-51 of plan 72-08). Given the
/// two nodes a `DrawWire` joins, in EITHER order, answer `Some((route, handler))` when
/// this drag is the one drag that mints a whole round trip, and `None` for every other
/// electrical pair.
///
/// # It is NARROW ON PURPOSE, and this is the reason
/// A Router emits no [`Effect::Reply`](fabrico_core::effect::Effect), so a return leg
/// drawn back to one is a cable that can never carry anything: a DECORATIVE cable, which
/// is precisely what D-06 forbids. The pairing exists because a request has an ANSWER,
/// and only a Handler produces one. Endpoint-to-Router, Router-to-Router and
/// Router-to-Endpoint therefore mint ONE wire exactly as they do today.
///
/// Do NOT read the narrowness as an unfinished generalisation and widen it. Widening it
/// mints cables that can never carry anything, which is a worse board than the one this
/// rule exists to make unreachable.
///
/// # Direction does not matter
/// The pairing is a property of the two MACHINES, not of which nub the user pressed
/// first. The caller derives the forward leg (Route Out to Handler In) and the return leg
/// (Handler Out to Route In) from the returned roles, never from the drag's own ports.
///
/// The two halves of the predicate are [`is_route`](GridLookup::is_route) and
/// [`is_handler`](GridLookup::is_handler); the Handler half is plan 72-06's R-37 naming
/// rule ([`is_handler_shape`](crate::is_handler_shape)), reused rather than restated.
fn route_handler_pair<V: GridLookup>(view: &V, a: NodeId, b: NodeId) -> Option<(NodeId, NodeId)> {
    if view.is_route(a) && view.is_handler(b) {
        Some((a, b))
    } else if view.is_route(b) && view.is_handler(a) {
        Some((b, a))
    } else {
        None
    }
}

/// The index of `node`'s FIRST electrical port with `role`, or `None` if it declares
/// none (72-08).
///
/// The paired legs are resolved from the two nodes' DECLARATIONS through this, never
/// from the drag's ports: the drag names at most one of the two legs, and a leg derived
/// from a port the user did not touch has to come from somewhere the user cannot skew.
/// FIRST, in declared index order, because that order is itself the catalog's
/// (`port_catalog_every_kind_lists_in_ports_first`) and is stable across a replay.
fn first_electrical_port<V: GridLookup>(view: &V, node: NodeId, role: Role) -> Option<PortId> {
    let ports = view.ports_of(node)?;
    ports
        .iter()
        .position(|p| p.role == role && p.medium == Medium::Electrical)
        .and_then(|i| PortId::try_from(i).ok())
}

/// Resolve and check ONE wire leg, answering the frozen [`EditOp::DrawWire`] or the
/// typed refusal (WIRE-01 steps 3 to 6, extracted at 72-08 so BOTH legs of a paired
/// draw run the IDENTICAL checks the single leg has always run).
///
/// Steps (1) resolve-the-handles and (2) the self-loop refusal stay at the call site:
/// they are questions about the COMMAND (two dense handles that may be stale or name one
/// node), not about a leg, and a paired draw asks them once for the drag rather than
/// twice for the two legs it derives.
///
/// Nothing here mutates and nothing here reads the drag: given the same view and the same
/// four values it returns the same answer, which is what lets the paired arm call it
/// twice and refuse the WHOLE command if either call refuses.
fn resolve_wire_leg<V: GridLookup>(
    view: &V,
    from_id: NodeId,
    from_port: PortId,
    to_id: NodeId,
    to_port: PortId,
) -> Result<EditOp, CommandError> {
    // (3) Resolve both declared ports. A port index naming no declared port is a
    //     fold-time no-op that mints a wire nothing reads, so it is refused here rather
    //     than allowed to produce dead topology.
    let fports = view.ports_of(from_id).ok_or(CommandError::IncompatiblePorts)?;
    let fport = fports
        .get(from_port as usize)
        .copied()
        .ok_or(CommandError::IncompatiblePorts)?;
    let tports = view.ports_of(to_id).ok_or(CommandError::IncompatiblePorts)?;
    let tport = tports
        .get(to_port as usize)
        .copied()
        .ok_or(CommandError::IncompatiblePorts)?;
    // (4) Role: a wire runs OUT of a source port and IN to a target port.
    //     `Role::Fault` is deliberately NOT accepted on the source side: the
    //     fault port's routing identity reconciles to the reserved FAULT_PORT
    //     sentinel, and a wire drawn out of it is a case this phase has not
    //     decided. Refusing it keeps the undecided case unreachable instead of
    //     shipping a guess (T-63-17).
    if fport.role != Role::Out || tport.role != Role::In {
        return Err(CommandError::IncompatiblePorts);
    }
    // (5) Medium, via the SHARED `mediums_compatible` predicate the Dock arm
    //     calls. A wire is ALWAYS an Electrical carrier, so both endpoints must
    //     speak Electrical. Calling the one predicate (rather than writing a
    //     second) is what stops the Dock and DrawWire accept-envelopes drifting
    //     apart (T-63-14).
    if !mediums_compatible(Medium::Electrical, fport.medium)
        || !mediums_compatible(Medium::Electrical, tport.medium)
    {
        return Err(CommandError::MediumMismatch);
    }
    // (6) Occupancy, in BOTH halves. An output port can already be busy two
    //     structurally different ways and neither predicate sees the other:
    //     - `link_exists` catches a BELT docked to it (a Tail dock links
    //       `(node, port) -> (belt, 0)`, so the key IS the source port). A
    //       second insert on that key would silently replace it and orphan the
    //       belt - the WR-04 re-wire guard. Today this half cannot bite through
    //       the command layer, because docking a Mechanical belt to the
    //       Electrical port a wire needs is already a `MediumMismatch` at step
    //       (5). It is asked anyway: it is the cheap half of a rule whose other
    //       half is load-bearing, and a third medium would make it reachable
    //       without anyone remembering to add it.
    //     - `wire_from_port_exists` catches a WIRE already drawn from it. A
    //       drawn wire's link is keyed on the WIRE's own port 0, NOT on the
    //       source port, so `links` records nothing there and `link_exists` is
    //       blind to it. Two wires out of one node is a SILENT loss rather than
    //       an overwrite: `wire_from_node` takes the lowest `NodeId` and the
    //       second wire is dead topology the user drew and can see (T-63-15).
    //
    //     THIS IS THE CHECK THAT REFUSES A SECOND ROUTE (R-52). Under D-02 a Handler
    //     declares ONE electrical Out, so pairing a second Route to a Handler that is
    //     already answering one refuses the RETURN leg here - and the paired arm then
    //     refuses the WHOLE command, minting NOTHING. A lone forward cable is exactly
    //     the forward-only board D-06 rules unreachable, and with a single Out a user
    //     reaches it by placing a second Route within a minute.
    if view.link_exists((from_id, from_port)) || view.wire_from_port_exists((from_id, from_port)) {
        return Err(CommandError::PortOccupied);
    }
    // Accept: FREEZE the resolved DrawWire. The fold mints the Node::Wire and its one
    // forward link and never re-checks any of the above.
    Ok(EditOp::DrawWire {
        from_node: from_id,
        from_port,
        to_node: to_id,
        to_port,
    })
}

/// The OTHER leg of the Route-and-Handler cable `node` belongs to, or `None` when `node`
/// is not a live wire, or is a wire that is not one leg of such a cable (72-08, R-53).
///
/// # It asks the SAME question the mint answered, from the other end
/// A leg is paired iff its two endpoints are a Route and a Handler
/// ([`route_handler_pair`]) AND a live wire runs back the other way from the answering
/// machine's first electrical Out ([`first_electrical_port`]). Those are the very two
/// facts [`validate_normalize`]'s `DrawWire` arm used to MINT the pair, read back rather
/// than re-derived, which is what keeps mint and delete from drifting into two rules.
///
/// # Why it is not "the two wires between these two nodes, opposite ways"
/// That cheaper structural rule needs no kinds and is WRONG in a way that is silent: a
/// user can hand-draw a Route-to-Router wire and a Router-to-Route wire, which is two
/// SINGLE cables and not a pair, and the cheap rule would cascade one delete into two.
/// R-51's narrowness is load-bearing on this side too.
///
/// Read-only, non-panicking, deterministic (every underlying walk is over a `BTreeMap`).
fn paired_wire_leg<V: GridLookup>(view: &V, node: NodeId) -> Option<NodeId> {
    let (from, to) = view.wire_endpoints(node)?;
    let (route, handler) = route_handler_pair(view, from.0, to.0)?;
    // The sibling runs the OTHER way. If this leg leaves the Route it is the forward leg
    // and its sibling leaves the Handler, and the other way round.
    let sibling_source = if from.0 == route { handler } else { route };
    let sibling_out = first_electrical_port(view, sibling_source, Role::Out)?;
    let sibling = view.wire_from_port((sibling_source, sibling_out))?;
    // A self-match cannot happen (the two legs leave different machines) but is refused
    // anyway rather than reasoned about: a delete that cascaded into itself would be a
    // duplicate record for one node, and the fold's second `remove_node` is a no-op that
    // would hide it.
    if sibling == node {
        return None;
    }
    // The sibling must come BACK to the machine this leg left, or the two are simply two
    // cables that share an endpoint rather than one round trip.
    let (_, sibling_to) = view.wire_endpoints(sibling)?;
    (sibling_to.0 == from.0).then_some(sibling)
}

/// True when `owner`, the node a prospective cell already belongs to, is a drawn BELT.
///
/// The ONE reading the Rotate and AddPort arms use to choose between a belt-specific
/// refusal (`RotateCoversBelt`, `GrowCoversBelt`, plan 74.1-18) and `FootprintCollision`,
/// and the Dock arm uses to name a belt-to-belt join (`InvalidBeltJoin`). It reads the LIVE node through `belt_geometry`, which both
/// producers answer from `core.state`, rather than the headless `kind_of` cache, whose
/// docblock records that it is written only at mint time. A drawn belt is the only node
/// that both owns cells and answers a non-empty geometry (a live wire answers an empty
/// one and owns no cell), so the answer is exactly "a belt tile is in the way".
fn covers_a_belt<V: GridLookup + ?Sized>(view: &V, owner: NodeId) -> bool {
    view.belt_geometry(owner).is_some_and(|g| !g.is_empty())
}

/// Validate ONE [`GridCommand`] against `view` and answer the RESOLVED records it must
/// fold, in fold order, ALL UNDER ONE ACTION ID.
///
/// # Why a GROUP and not one record (D-04, ruling R-50 of plan 72-08)
/// One command was one record until 72-08. A drag between a Route and a Handler now
/// mints BOTH cable legs, and D-04 requires that to be ONE command, ONE action id and
/// ONE undo step - so two `GridCommand`s (a frontend pairing) is ruled out outright, and
/// a second `GridCommand` variant for a paired draw is ruled out too because it would let
/// the CALLER choose whether a pair is minted, putting D-06's "no forward-only board is
/// reachable" in a frontend literal.
///
/// Making THIS function the thing that returns a group is what leaves the caller no
/// choice: both producers ([`GridSession::apply`] and the host's `apply_gesture`) fold
/// whatever comes back, and neither can express "just the forward leg".
///
/// Every arm but `DrawWire`, `Delete` and `Rotate` returns exactly ONE record, so the group
/// is a one-element `Vec` for every command that existed before 72-08. Since phase 89 (D-08)
/// a `Rotate` returns the turn plus one `Dock` per loose belt end it now faces, and exactly
/// the one `Rotate` record when it faces none.
///
/// # Errors
/// The typed [`CommandError`] for the refused command. A refusal produces NOTHING: for a
/// paired draw or a paired delete that means NEITHER leg, never one of two (R-52).
pub fn validate_normalize<V: GridLookup>(
    view: &V,
    cmd: GridCommand,
) -> Result<Vec<EditRecord>, CommandError> {
    // The SECOND resolved op, set ONLY by the two paired arms (`DrawWire`'s return leg,
    // `Delete`'s sibling leg) and `None` for every other command. It rides beside `op`
    // rather than turning the whole `match` into a `Vec` so that the thirteen arms that
    // mint exactly one record read EXACTLY as they did before 72-08.
    let mut paired: Option<EditOp> = None;
    // The records a command adds AFTER `op` and `paired`, set ONLY by the `Rotate` arm (the
    // docks a turn makes, D-08) and EMPTY for every other command, so every other group is
    // exactly what it was before phase 89.
    let mut extra: Vec<EditOp> = Vec::new();
    let op = match cmd {
        GridCommand::Place {
            kind,
            cell_x,
            cell_y,
        } => {
            // The Place kind-validation the host's Reject lacks: the byte must name a
            // kind the catalog can resolve, asked BEFORE the catalog is consulted. See
            // [`kind_has_catalog_arm`] for why this is an allow-set and not a bound.
            if !kind_has_catalog_arm(kind) {
                return Err(CommandError::UnknownKind);
            }
            // 17-02 (CAT-04 / CLEAN-06): a belt is NEVER placed — belts come only from
            // DrawBelt + Dock after the node→node Wire removal. Reject BEFORE catalog
            // resolution so a belt can never be minted via Place (the fold_place BELT
            // mint arm is gone); produces NOTHING (SC#2).
            if kind == machine_kind::BELT {
                return Err(CommandError::BeltNotPlaceable);
            }
            // 10-04: resolve the per-kind footprint + ports from the catalog (Pattern
            // 3), then validate the WHOLE footprint atomically before producing — a
            // reject produces nothing (SC#2). Every footprint cell is bounds-checked
            // (Pitfall 5: a multi-cell box near GRID_MAX can spill off-grid even when
            // its anchor is in-bounds) AND collision-checked. The FIRST out-of-bounds
            // or occupied cell rejects the ENTIRE placement (atomic, never partial,
            // never an eviction). A 1×1 machine is just a single-cell footprint, so
            // this is the strict generalization of the old single-cell checks.
            let (footprint, ports) = port_catalog(kind);
            for c in cells_of_footprint((cell_x, cell_y), footprint.w, footprint.h, footprint.rot) {
                if !in_bounds(c) {
                    return Err(CommandError::OutOfBounds);
                }
                // Any live owner collides (a `Place` has no moving self to exclude;
                // the self-owned-cell exclusion is a future Rotate re-check, 10-06).
                if view.occupied_by(c).is_some() {
                    return Err(CommandError::FootprintCollision);
                }
            }
            // Accept: FREEZE the resolved dims + ports into the record so the fold +
            // every replay apply them VERBATIM (no catalog lookup — decision Q2).
            // Every forward placement is rot 0 (EDIT 13, plan 86-02): only the inverse of a
            // Delete writes another rotation.
            EditOp::Place {
                kind,
                cell_x,
                cell_y,
                w: footprint.w,
                h: footprint.h,
                ports,
                rot: 0,
            }
        }
        GridCommand::Delete { node } => {
            let node_id = view.resolve(node).ok_or(CommandError::UnknownNode)?;
            // Capture the resolved kind + cell at delete time so the log is
            // head/append-aware for Phase-12 inverse-append (decision FORK 1). A
            // belt has no cell -> (0, 0); kind is always present for a live node.
            let kind = view.kind_of(node_id).ok_or(CommandError::UnknownNode)?;
            let (cell_x, cell_y) = view.cell_of(node_id).unwrap_or((0, 0));
            // THE PAIRED DELETE (D-04, ruling R-53 of plan 72-08). Deleting EITHER leg
            // of a Route-and-Handler cable removes BOTH, under the one action id every
            // record of this command shares.
            //
            // This is not tidiness, it is the OTHER half of D-06. The paired mint above
            // makes a forward-only board unreachable by drawing; without this, the very
            // next gesture reaches it by deleting. `ConfigPanel.tsx:1163-1167`'s
            // Disconnect on a wire row emits exactly this `Delete { node: link.wire }`,
            // so the cascade IS the Disconnect behaviour and UI-SPEC 5.6 needs no
            // frontend change at all.
            //
            // NO CONFIRMATION DIALOG. The pair is one undo step and undo restores it;
            // `DeleteGuardDialog` is reserved for a delete that destroys carried items.
            //
            // PHASE 73 OWNS RESTORING THE PAIR AS ONE UNDO STEP, and inherits this rule.
            // D-04's reversibility is recorded as COSTLY for exactly this reason:
            // splitting the pairing later means re-opening this cascade, because the two
            // legs are minted and removed as one action and an undo that restores one of
            // them restores a board D-06 rules unreachable. The belt and wire undo
            // defects UNDO-01 to UNDO-03 are NOT touched here.
            if let Some(sibling) = paired_wire_leg(view, node_id) {
                let sibling_kind = view.kind_of(sibling).ok_or(CommandError::UnknownNode)?;
                paired = Some(EditOp::Delete {
                    node: sibling,
                    kind: sibling_kind,
                    // A wire has no anchor cell; `cell_of` returns `None` for one and the
                    // sentinel `(0, 0)` is what the DrawWire undo inverse already freezes
                    // for a wire Delete.
                    cell_x: 0,
                    cell_y: 0,
                    captured: DeletedSubgraph::default(),
                });
            }
            EditOp::Delete {
                node: node_id,
                kind,
                cell_x,
                cell_y,
                // 12-02: the captured inverse subgraph FIELD now exists but stays
                // default-empty here — real subgraph population (footprint + cascade
                // belts) is plan 12-05's job. Empty keeps the fold byte-identical.
                captured: DeletedSubgraph::default(),
            }
        }
        GridCommand::Rotate { node, ccw } => {
            // Resolve the dense handle to a live NodeId (unknown -> reject).
            let node_id = view.resolve(node).ok_or(CommandError::UnknownNode)?;
            // Phase 76 (D-04, research Pitfall 6): A LABEL NEVER TURNS. Refused here, at
            // the top of the arm and before any geometry, because the anchor-preserving
            // pivot below would otherwise accept a forged Rotate on a free 4x1 label and
            // turn it into a 1x4 whose words (drawn unrotated) no longer fit it. The UI
            // sends no Rotate for a label at all; `WrongKind` (plan 88-02, `Malformed` before)
            // says the edit does not apply to what was picked, true of the only way here.
            if view.kind_of(node_id) == Some(machine_kind::LABEL) {
                return Err(CommandError::WrongKind);
            }
            // Read the node's anchor + current footprint (absent ⇒ the faithful
            // 1×1-rot0 default). A node with no cell (a Wire-minted belt) cannot be
            // rotated -> UnknownNode (nothing spatial to pivot).
            let anchor = view.cell_of(node_id).ok_or(CommandError::UnknownNode)?;
            let foot = view.footprint_of(node_id).ok_or(CommandError::UnknownNode)?;
            let old_rot = foot.rot;
            // RELATIVE -> ABSOLUTE (Open Q2): CW is +1, CCW is +3 (≡ -1) mod 4.
            let new_rot = (old_rot + if ccw { 3 } else { 1 }) & 3;
            // Anchor-preserving pivot: re-collision-check + bounds-check EVERY rotated
            // cell (Pitfall 5 — a multi-cell box can spill off-grid even when its
            // anchor is in-bounds). EXCLUDE the moving node's OWN cells on the overlap
            // check (§Atomic Multi-Cell Collision): a cell the node already owns is not
            // a collision with itself. The FIRST bad cell rejects the WHOLE rotation
            // atomically (state byte-identical, no auto-shift). A 1×1's single anchor
            // cell is owned by the node, so a 1×1 rotate is always accepted (a no-op on
            // occupancy).
            //
            // WHICH TAG (the "Refuse, say why" decision): the FIRST
            // foreign cell of this walk decides. A BELT there is `RotateCoversBelt`, whose
            // sentence names the belt and the fix; a machine there stays
            // `FootprintCollision`. The walk and its order are untouched, so the same cell
            // is first and only the tag of an already-refused Rotate moved.
            for c in cells_of_footprint(anchor, foot.w, foot.h, new_rot) {
                if !in_bounds(c) {
                    return Err(CommandError::OutOfBounds);
                }
                if let Some(owner) = view.occupied_by(c)
                    && owner != node_id
                {
                    return Err(if covers_a_belt(view, owner) {
                        CommandError::RotateCoversBelt
                    } else {
                        CommandError::RotateBlocked
                    });
                }
            }
            // THE TURN DOCKS WHAT IT NOW FACES (phase 89, D-08). After the walk accepts
            // `new_rot`, every loose belt end a port of this node faces at `new_rot` with a
            // matching role is docked by a `Dock` record in this same group, so the group is
            // `[Rotate, Dock, ...]` under one action id and one Undo reverts the turn and its
            // docks together (the Dock inverts to an Unlink; the Rotate's own compensation
            // still answers for what it cut). The fold is unchanged and still only severs: the
            // joins are logged records, made by the rule [`turn_docks`] states. A turn that
            // faces no loose end adds nothing, so its group stays the one bare `Rotate`.
            extra = turn_docks(view, node_id, anchor, foot, new_rot);
            // Accept: FREEZE the resolved ABSOLUTE new_rot + the old_rot it replaced
            // (both captured for Phase-12 inverse-append). The fold applies new_rot
            // VERBATIM (decision Q2).
            EditOp::Rotate {
                node: node_id,
                new_rot,
                old_rot,
            }
        }
        GridCommand::DrawBelt { cells } => {
            // (1) Resolve the RAW drawn cells through the ONE shared pure route()
            //     normalizer — the IDENTICAL fn the UI ghost preview calls, so the
            //     committed tiles are byte-identical to the preview (preview==commit,
            //     BELT-03). A malformed path (empty/non-adjacent/self-crossing) wraps
            //     its typed RouteError into CommandError::Route and rejects the WHOLE
            //     belt, producing nothing (no panic, no guess — T-11-ROUTE).
            let tiles = route(&cells).map_err(CommandError::Route)?;
            // (1b) Cap the resolved tile COUNT against the same bound the snapshot
            //      trust gate (`BeltTilesTooMany`) and the `edit::upcast` decode guard
            //      enforce (CR-02). `route()` only rejects self-crossing paths, so a
            //      non-crossing "snake" of several thousand free cells would otherwise
            //      fold into a belt with `geometry.len() > MAX_BELT_TILES` — a live
            //      `Core` that then FAILS its own `restore(snapshot(core))` round-trip
            //      (save/load data loss). The command layer's acceptance envelope MUST
            //      match the round-trip envelope; reject atomically (state byte-identical,
            //      SC#2), mirroring the symmetric `Place` MAX_FOOTPRINT_DIM bound.
            if tiles.len() > fabrico_core::edit::MAX_BELT_TILES as usize {
                return Err(CommandError::BeltTooLong);
            }
            // (2) Atomically collision-check EVERY resolved tile cell against the
            //     unified occupancy (BELT-06), mirroring the Place arm's whole-
            //     footprint loop. The FIRST out-of-bounds OR occupied cell rejects the
            //     ENTIRE path (never partial, never an eviction). A reject produces
            //     NOTHING (state byte-identical, SC#2). Taxonomy reuse (per plan): an
            //     occupied cell surfaces as FootprintCollision — a belt cannot overlap
            //     another belt or a machine body — and an off-grid cell as OutOfBounds.
            for t in &tiles {
                if !in_bounds(t.cell) {
                    return Err(CommandError::OutOfBounds);
                }
                if view.occupied(t.cell) {
                    return Err(CommandError::FootprintCollision);
                }
            }
            // Accept: FREEZE the resolved tiles into the record so the fold + every
            // replay apply them VERBATIM and NEVER re-route (BELT-04, decision Q2).
            EditOp::DrawBelt { tiles }
        }
        GridCommand::Dock {
            belt,
            endpoint,
            node,
            port,
        } => {
            // Resolve both dense handles to live NodeIds (unknown -> reject).
            let belt_id = view.resolve(belt).ok_or(CommandError::UnknownNode)?;
            let node_id = view.resolve(node).ok_or(CommandError::UnknownNode)?;
            // Phase 76 (D-07): A LABEL NEVER CONNECTS, on either side of a Dock, and this
            // is checked BEFORE the `FAULT_PORT` exemption below, which skips all geometry
            // and so linked a belt anywhere on the board to a label (WINDOWS 68).
            if is_label(view, belt_id) || is_label(view, node_id) {
                return Err(CommandError::LabelDoesNotConnect);
            }
            // Map the wire-level BeltEnd to the core edit-log BeltEnd (independent
            // crates, lockstep types — mirror the duplicated `machine_kind`).
            let core_end = match endpoint {
                fabrico_protocol::BeltEnd::Head => BeltEnd::Head,
                fabrico_protocol::BeltEnd::Tail => BeltEnd::Tail,
            };
            // FAULT_PORT exemption — kept ONLY for a genuinely NON-SPATIAL fault port
            // (a node with no `Role::Fault` nub, e.g. a router whose fault output is
            // the reserved logical sentinel with no perimeter cell): `port ==
            // FAULT_PORT` passed directly skips ALL spatial dock geometry.
            //
            // The exemption is NODE-AWARE (20-review WR-03): the sentinel alone no
            // longer bypasses geometry. When the target node DOES declare a spatial
            // `Role::Fault` nub, the sentinel is resolved to that nub's catalog
            // index and routed through the FULL spatial validation below —
            // exactly as if the client had addressed the nub by index. Without
            // this, a wire client sending `port: FAULT_PORT` directly (any wire
            // client can — `port` is a plain u16) skipped adjacency/facing/drawn-
            // belt checks and linked a spatially-disconnected belt to a FACTORY's
            // fault output, while the SAME logical link addressed via catalog
            // index 2 was rejected — two disagreeing accept envelopes, and a later
            // Rotate's `dock_still_reaches` (which resolves FAULT_PORT to the real
            // nub) judging geometry the accept path never validated.
            //
            // A FACTORY's `Role::Fault` port, by contrast, is a REAL spatial nub
            // (S-center, catalog index 2). It is docked by its SPATIAL INDEX and is
            // validated EXACTLY like an `Out` dock (facing-adjacency, offload
            // direction) — decision (b) / RESEARCH Option A. Its dock link key is then
            // resolved to `FAULT_PORT` below (`link_port`) so the dock key equals the
            // fault-emit key and a docked fault belt actually receives faulted items.
            let mut link_port = port;
            let spatial_port = resolve_spatial_port(view.ports_of(node_id), port);
            // THE OCCUPANCY RULE (74-06, LINK-06), defined ONCE here and asked by BOTH
            // the spatial branch and the non-spatial fault branch below, so the two
            // cannot drift apart the way two hand-written copies would.
            //
            // It is the SAME two-half rule `validate_draw_wire` step (6) applies, and it
            // is the shipped predicate pair rather than a fresh check, for the reason
            // that step's own docblock gives: an output port can already be busy two
            // structurally different ways and NEITHER predicate sees the other.
            //
            // - `link_exists` catches a BELT already docked to it. It must be asked with
            //   the LINK KEY `fold_dock` writes (the ROUTING key for an `Out`), because
            //   that is the key `links` is keyed on.
            // - `wire_from_port_exists` catches a WIRE already drawn from it. It must be
            //   asked with the RAW CATALOG INDEX, because a `WireLink.from` records the
            //   index the client named and never the routing translation. A drawn wire's
            //   one `links` entry is keyed on the WIRE's own port 0, so `links` holds
            //   nothing at the source port at all and `link_exists` is structurally
            //   blind to it (T-63-15).
            //
            // Two keyspaces, one question. Asking either predicate with the other's key
            // would make it silently blind, which is why both keys are passed in.
            //
            // WHAT IT PREVENTS: `fold_dock` links through `GridState::link`, a bare
            // insert. Without this guard a second `Dock` naming an already-connected
            // output returned `Ok`, REPLACED the entry, and the connection the user drew
            // was gone with no message anywhere (WINDOWS 128). A machine output that is
            // taken returns `CommandError::PortOccupied` ("That output is already connected.
            // Disconnect it first."); since plan 74.1-32 a drawn belt's END that is taken
            // returns `CommandError::BeltEndTaken` instead (the spatial branch below says
            // which arms), because the user handled a belt end, not an output (HEAD-WORDS).
            //
            // IT LIVES HERE AND NEVER IN `GridState::link`. `fold_dock` calls `link` on
            // every replay and the fold NEVER re-validates by design (decision Q2), so a
            // guard down there would make a valid certified log refuse itself on reload -
            // a determinism break dressed as a safety check. Pinned by
            // `the_guard_is_above_the_fold_so_a_certified_log_still_replays`.
            let source_occupied = |link_key: (NodeId, PortId), raw_key: (NodeId, PortId)| {
                view.wire_from_port_exists(raw_key) || view.link_exists(link_key)
            };
            if let Some(port) = spatial_port {
                // The carrier must be a DRAWN belt (non-empty geometry) to have a
                // spatial endpoint to dock; a Wire-minted BELT has none -> InvalidDock.
                let geom = view.belt_geometry(belt_id).ok_or(CommandError::InvalidDock)?;
                // THE WIRE-CARRIER BRANCH (74-06, LINK-05), stated explicitly rather
                // than left to fall through, because a reader has to be able to see
                // that the skip below is deliberate.
                //
                // `belt_geometry` answers `Some` with an EMPTY tile list for exactly
                // one node kind, a live `Node::Wire`, so this boolean names the wire
                // carrier and nothing else. A geometry-empty BELT answers `None` and
                // was already refused on the line above.
                //
                // WHAT IT CHANGES, AND WHAT IT DOES NOT. Until this commit a `Dock`
                // naming a wire died right here while the matching `Unlink` returned
                // `Ok`, so a hand-drawn wire could be DISCONNECTED and never
                // reconnected (WINDOWS 65). That asymmetry lived in this one line.
                // A wire has no cells, so there is no adjacency and no facing for the
                // spatial rules to judge; `acceptsWireTarget`'s docblock on the
                // frontend carries the same sentence in capitals, and `DrawWire`
                // applies no spatial check either. So the wire carrier SKIPS the
                // adjacency and facing checks and NOTHING else: it still runs the role
                // rule, the medium gate through the shared `mediums_compatible`, and
                // the occupancy guard. The link it writes is byte-for-byte the one
                // `fold_draw_wire` writes.
                let carrier_is_wire = geom.is_empty();
                // The CARRIER belt's ENDPOINT cell + its OUTWARD side (toward whatever it
                // docks to), through the ONE shared definition in `fabrico-core`
                // (LINK-11). This block used to write the derivation out longhand, byte
                // for byte identical to a second copy inside `GridState::dock_still_reaches`
                // in another crate; both copies are gone and both sites call
                // `belt_end_world` now. A single-tile belt has no inner neighbour and so
                // no inherent direction (`outward == None`); adjacency alone decides for it.
                //
                // A wire carrier has no end cell to resolve, so the resolver is not
                // asked at all: `belt_end_world` of an empty geometry answers `None`,
                // and asking it here would refuse the very case this branch admits.
                let carrier_end = if carrier_is_wire {
                    None
                } else {
                    Some(belt_end_world(geom, core_end).ok_or(CommandError::InvalidDock)?)
                };
                // THE JOIN'S OWN TAG (plan 74.1-18, gap N4c), decided HERE, before the role
                // check, so the role refusal of a belt-to-belt join carries it too. A
                // DRAWN-BELT carrier docking onto a DRAWN-BELT target is a join, and the
                // geometric refusals below (role, the inner tile, the single-tile target)
                // return `InvalidBeltJoin`, whose sentence states the belt rule; ends that
                // are not one step apart return `BeltEndsApart` and the U-turn facing term
                // `BeltJoinTurnsBack`, each naming its own cause (plan 74.1-24, gap J11). Every other shape keeps
                // `InvalidDock`, whose sentence names output, input and next-to, true of a
                // machine port. Deciding the shape early reads the target's geometry and
                // nothing else, so which docks are accepted is unchanged; a port index
                // naming no port, the wire-carrier rules, the medium gate and occupancy
                // keep their own tags (occupancy: `PortOccupied`, or since plan 74.1-32
                // `BeltEndTaken` when the taken source is a drawn belt's end).
                let rule_refusal = if !carrier_is_wire && covers_a_belt(view, node_id) {
                    CommandError::InvalidBeltJoin
                } else {
                    CommandError::InvalidDock
                };
                // Resolve the machine port (absent index / port-less -> InvalidDock).
                // Keep the full catalog slice in scope: the Role::Out link-key
                // translation below counts the Out ports preceding `port`.
                let mports = view.ports_of(node_id).ok_or(CommandError::InvalidDock)?;
                let mport = mports
                    .get(port as usize)
                    .copied()
                    .ok_or(CommandError::InvalidDock)?;
                // Role must match the dock DIRECTION: a HEAD (load) dock targets a
                // machine `In`; a TAIL (offload) dock targets a machine `Out` OR the
                // OUTPUT `Role::Fault` port. Errors flow OUT of the fault port (same
                // direction as `Out`) so a belt may only OFFLOAD from it (Tail dock),
                // NEVER flow in (no `Role::Fault` on a Head/load dock) — decision (b).
                let role_ok = match core_end {
                    BeltEnd::Head => mport.role == Role::In,
                    BeltEnd::Tail => matches!(mport.role, Role::Out | Role::Fault),
                };
                if !role_ok {
                    return Err(rule_refusal);
                }
                // A WIRE carrier is admitted in the HEAD direction ONLY, and the
                // narrowing is deliberate rather than an omission. A Head dock writes
                // `link((wire,0) -> (node,port))`, which is EXACTLY the link
                // `fold_draw_wire` writes, so the reconnect restores a drawn wire and
                // invents nothing. A Tail dock would write `link((node,port) ->
                // (wire,0))`, a shape no wire in this model has ever had: a wire's
                // source endpoint lives on its own `WireLink`, never in `links`. That
                // is an accept-envelope widening with no gesture behind it and nothing
                // reading the result, so it is refused. Pinned by
                // `a_tail_dock_naming_a_wire_is_refused_because_no_wire_has_that_link_shape`.
                if carrier_is_wire && core_end == BeltEnd::Tail {
                    return Err(CommandError::InvalidDock);
                }
                // PORT-08 medium gate: a belt is ALWAYS a Mechanical carrier. Reject
                // docking it onto a port whose medium is incompatible (e.g. an
                // Electrical/wire port) via the SHARED `mediums_compatible` predicate,
                // right after the role check and BEFORE any geometry/freeze — a typed,
                // RETURNED-only reject (never serialized), producing nothing and leaving
                // state byte-identical (SC#2), never a silent hang. The `DrawWire` arm
                // below calls the SAME predicate for the wire->port direction, on both
                // of a drawn wire's endpoints (63-02) — one definition, two directions.
                //
                // A WIRE carrier is ALWAYS an Electrical carrier, exactly as
                // `validate_draw_wire` step (5) declares it, so the same gate runs with
                // the carrier's own medium rather than being skipped. This is what
                // keeps the reconnect refusing precisely what the original `DrawWire`
                // refuses: naming a Mechanical port earns `MediumMismatch` from the
                // same predicate, in both verbs.
                let carrier_medium =
                    if carrier_is_wire { Medium::Electrical } else { Medium::Mechanical };
                if !mediums_compatible(carrier_medium, mport.medium) {
                    return Err(CommandError::MediumMismatch);
                }
                // The TARGET port's world cell + the side it faces. Two SHAPES of target,
                // and since plan 74.1-15 they are judged by TWO adjacency rules and ONE
                // facing rule (the narrowed 74.1 D-02 term, below, never split by shape):
                //
                // - A MACHINE port keeps the DOORSTEP rule: the carrier's end must sit
                //   exactly on `port cell + unit_delta(port side)`. A machine port faces
                //   one way and cannot turn, so the belt is the only thing that can.
                // - A BELT end is accepted when the carrier's end cell is ONE ORTHOGONAL
                //   STEP from the target end's cell and is NOT the target's inner tile
                //   (the tile next to the target end inside the target belt). A belt end
                //   is a tile that can itself turn, so either belt of a join may bend
                //   at the seam, and the cell step decides which (`seam_flow`).
                //
                // WHY THE BELT RULE CHANGED (a usability review rejected, on
                // 2026-10-04, a belt run from an output to an input right next to it
                // being treated as an error). The belt branch used to share the doorstep rule,
                // which demanded that the TARGET end point straight at the carrier. On
                // the dry-run board (main belt (4,6)->(7,6) east, side belt (4,3)->(4,5)
                // south) dragging the main belt's Tail onto the side belt's Head joined,
                // and dragging the side belt's Head onto the main belt's Tail, the same
                // physical join, was refused. Both now join and leave the same link
                // (`tests/belt_join_both_ways.rs`).
                //
                // THE U-TURN STAYS REFUSED, and that is a stated assumption that can be
                // turned around after further usability testing: two side-by-side belts running opposite
                // ways, one's end next to the other's start, pass the cell step and fail
                // the uniform facing term (the carrier's outward side equals the target
                // end's side) in BOTH drag directions.
                //
                // A MACHINE port answers through `port_world`, which needs the node's
                // anchor and footprint. A BELT has NEITHER: it records no `cells` entry
                // and no `footprints` entry, so `port_world` structurally cannot serve
                // it. A belt end answers through the SAME `belt_end_world` the carrier
                // side just used, and its OUTWARD side plays exactly the role a machine
                // port's facing side plays: the direction the dock partner sits in.
                //
                // Which END of the target belt is named is read off the resolved port's
                // ROLE, not off the raw index, because the role is what the direction
                // rule above already agreed with: a Head (load) dock targets the
                // partner's admit end (`Role::In` = Tail), a Tail (offload) dock targets
                // its deliver end (`Role::Out` = Head). A belt declares no `Role::Fault`
                // port, so that arm is unreachable and is refused rather than guessed.
                //
                // The whole spatial block below runs for a DRAWN-BELT carrier only.
                // `carrier_end` is `None` for a wire carrier, and a wire has no cell
                // for either the adjacency or the facing rule to be about, so there is
                // nothing here for it to satisfy or to fail. The skip is ONLY of the
                // two spatial rules: the role rule, the medium gate and the occupancy
                // guard all ran, or will run, for the wire carrier too.
                if let Some((end_cell, outward)) = carrier_end {
                    // `belt_inner` is `Some(target inner tile)` for a BELT target and
                    // `None` for a MACHINE target: it is both the shape switch for the
                    // adjacency rule below and the tile the belt rule must not accept.
                    let (mcell, mside, belt_inner) = match view.belt_geometry(node_id) {
                        // An EMPTY target geometry is a `Node::Wire` TARGET, and
                        // `belt_end_world` answers `None` for it, so a wire cannot be
                        // docked ONTO. Refused rather than admitted: a wire has no end
                        // in world space for a belt to meet, which is a different
                        // question from a wire being reconnectable as a CARRIER.
                        Some(tgeom) => {
                            let tend = match mport.role {
                                Role::In => BeltEnd::Tail,
                                Role::Out => BeltEnd::Head,
                                Role::Fault => return Err(rule_refusal),
                            };
                            let (tcell, tside) =
                                belt_end_world(tgeom, tend).ok_or(rule_refusal)?;
                            // A SINGLE-TILE target belt has an end cell but no inherent
                            // direction, so there is no side for the facing rule to judge and
                            // no honest way to accept it. Refused, not waved through: an
                            // accept here would be a dock the rotate-time `dock_still_reaches`
                            // predicate could not reproduce.
                            let tside = tside.ok_or(rule_refusal)?;
                            // The target's INNER tile: its end cell stepped AGAINST its
                            // outward side, which is the inner neighbour `belt_end_world`
                            // derived the side from.
                            let (ix, iy) = unit_delta(tside);
                            (tcell, tside, Some((tcell.0 - ix, tcell.1 - iy)))
                        }
                        None => {
                            let mfoot =
                                view.footprint_of(node_id).ok_or(CommandError::InvalidDock)?;
                            let manchor = view.cell_of(node_id).ok_or(CommandError::InvalidDock)?;
                            let (pcell, pside) =
                                port_world(manchor, mfoot.w, mfoot.h, mfoot.rot, &mport);
                            (pcell, pside, None)
                        }
                    };
                    match belt_inner {
                        // A MACHINE target: the port's world-cell stepped toward its
                        // facing side must land EXACTLY on the carrier belt's endpoint
                        // cell (the doorstep rule, unchanged by plan 74.1-15).
                        None => {
                            let (dx, dy) = unit_delta(mside);
                            if (mcell.0 + dx, mcell.1 + dy) != end_cell {
                                return Err(CommandError::InvalidDock);
                            }
                        }
                        // A BELT target (plan 74.1-15, gap N4): the carrier's end cell is
                        // one orthogonal step from the target end's cell, in any of the
                        // four directions but one, and that one is the target's inner
                        // tile. `abs_diff` keeps the step test overflow-free on any cell.
                        //
                        // WHICH TAG (plan 74.1-24, gap J11): the two halves of this term
                        // return their own tags. Ends that are not one orthogonal step apart
                        // (two apart, or a diagonal neighbour) do not touch, and say so as
                        // `BeltEndsApart`; the carrier end on the target's own inner tile
                        // (only a self-dock reaches it, and it IS one step away) keeps
                        // `rule_refusal` (`InvalidBeltJoin`). Which docks are accepted is
                        // unchanged: the two conditions are the old disjunction, split.
                        Some(inner) => {
                            let one_step = matches!(
                                (end_cell.0.abs_diff(mcell.0), end_cell.1.abs_diff(mcell.1)),
                                (1, 0) | (0, 1)
                            );
                            if !one_step {
                                return Err(CommandError::BeltEndsApart);
                            }
                            if end_cell == inner {
                                return Err(rule_refusal);
                            }
                        }
                    }
                    // FACING, NARROWED IN PHASE 74.1 (D-02). A multi-tile carrier has a
                    // derived outward side, and it is refused on facing ONLY when that side
                    // EQUALS the target side: the one geometry where the carrier's inner
                    // tile sits on the target's own cell. A carrier that leaves the doorstep
                    // straight (outward opposite the target side) or TURNS AT IT (outward
                    // perpendicular) is accepted, which is what lets a belt drawn out of a
                    // port turn at once and still dock (CORNER-01).
                    //
                    // FOR A BELT TARGET (since plan 74.1-15) this term is reachable on a
                    // command-built board, and it is the one belt-to-belt shape it refuses
                    // there: the U-TURN, two side-by-side belts running opposite ways with
                    // one's end next to the other's start. Both drag directions pass the
                    // cell step and fail here, because the carrier's outward side equals
                    // the target end's side. Refusing it is the stated assumption of plan
                    // 74.1-15 (pinned by `a_u_turn_join_is_refused_both_ways`).
                    //
                    // FOR A MACHINE TARGET, on every command-produced state the refused
                    // shape is a footprint
                    // collision before it is ever a dock (DrawBelt, Rotate and AddPort all
                    // refuse a belt tile on a machine cell), so this term is reachable only
                    // on a board a forged or hand-edited log already built. It is KEPT
                    // (D-13), and what it guards is narrow (review IN-02): it refuses a LIVE
                    // Dock command issued on such a board, and the fold's copy of the
                    // predicate (`dock_still_reaches`) releases such a dock on the next
                    // Rotate. A forged log that carries the `EditOp::Dock` record itself is
                    // folded verbatim (`fold_dock` never re-validates, decision Q2) and is
                    // NOT defended here; the snapshot trust gate checks no dock geometry.
                    // ONE predicate for the machine-socket and the belt-seam arms above; it
                    // is never split by target shape. A single-tile carrier has no inherent
                    // direction, so adjacency alone decides for it.
                    //
                    // WHICH TAG (plan 74.1-24, gap J11): a BELT target that fails this term is
                    // the U-turn, and it carries its own cause, `BeltJoinTurnsBack`, so the
                    // user reads that the join turns back rather than the whole belt rule. A
                    // machine target keeps `rule_refusal` (`InvalidDock`).
                    if let Some(oside) = outward
                        && oside == mside
                    {
                        return Err(if belt_inner.is_some() {
                            CommandError::BeltJoinTurnsBack
                        } else {
                            rule_refusal
                        });
                    }
                }
                // Translate the validated SPATIAL index into the LINK KEY the fold
                // writes. Shared with the `Unlink` arm below (63-05) — one
                // translation, both directions of the verb, because a disconnect that
                // computed a different key from the same fields would report success
                // and remove nothing.
                link_port = dock_link_key(mports, port);
                // OCCUPANCY, last of the checks and after every geometric one, so a
                // misaimed drop still earns the sentence that names the rule it missed
                // rather than one about a port it was never going to reach.
                //
                // WHICH END OWNS THE OUTPUT depends on the direction, because that is
                // what decides the key `fold_dock` inserts on:
                // - HEAD (load): `link((belt,0) -> (node,port))`, so the source is the
                //   CARRIER's own port 0. Its raw and link keys are the same number.
                // - TAIL (offload): `link((node,key) -> (belt,0))`, so the source is the
                //   TARGET's output, under the two keys described above.
                let occupied = match core_end {
                    BeltEnd::Head => source_occupied((belt_id, 0), (belt_id, 0)),
                    BeltEnd::Tail => source_occupied((node_id, link_port), (node_id, port)),
                };
                // WHICH TAG (plan 74.1-32, the third re-walk's HEAD-WORDS): the source that
                // is taken decides. It is a drawn BELT'S END in two arms, and the user is told
                // so (`BeltEndTaken`, "That belt end is already joined. Use a free end."):
                // - a HEAD dock from a drawn-belt carrier: the source is the carrier's own Head;
                // - a TAIL dock onto a drawn-belt target: the source is that belt's Head.
                // A machine Out or Fault, and every wire carrier, keep `PortOccupied`, whose
                // sentence names the output the user really dropped on. Only the tag of an
                // already-refused dock moved; which docks are accepted is unchanged.
                if occupied {
                    let belt_end = !carrier_is_wire
                        && (core_end == BeltEnd::Head || covers_a_belt(view, node_id));
                    return Err(if belt_end {
                        CommandError::BeltEndTaken
                    } else {
                        CommandError::PortOccupied
                    });
                }
            } else if core_end == BeltEnd::Head {
                // WR-04: the non-spatial `FAULT_PORT` branch skips ALL geometry, but a
                // fault port is offload-only — errors flow OUT of it, so a belt may only
                // OFFLOAD (Tail), NEVER flow IN. Reject a Head (load) dock BEFORE linking,
                // mirroring the spatial path's `role_ok` direction check above
                // (`Head => In`, so a Head dock to a `Role::Fault` port is rejected). A
                // Tail dock to the non-spatial sentinel (offload) stays valid. Without
                // this guard `Dock { endpoint: Head, port: FAULT_PORT }` would link a belt
                // delivering INTO an output-only fault port — the accept-path asymmetry
                // the spatial and non-spatial fault-dock paths must not disagree on.
                return Err(CommandError::InvalidDock);
            } else if source_occupied((node_id, FAULT_PORT), (node_id, FAULT_PORT)) {
                // The SAME occupancy rule on the non-spatial sentinel, through the SAME
                // closure. `spatial_port` is `None` only when `port == FAULT_PORT` and
                // the node declares no `Role::Fault` nub, so `link_port` is already the
                // sentinel and the raw and link keys coincide.
                //
                // This branch needs the guard MORE than the spatial one, not less: it
                // checks no geometry at all, so ANY belt anywhere on the board can name
                // this key and overwrite whatever fault belt was already attached.
                return Err(CommandError::PortOccupied);
            }
            // Accept: FREEZE the resolved Dock with resolved NodeIds + the resolved
            // link-key port (`FAULT_PORT` for a fault dock, else the spatial index).
            // The fold links it VERBATIM per the direction; replay never re-validates
            // (decision Q2).
            EditOp::Dock {
                belt: belt_id,
                endpoint: core_end,
                node: node_id,
                port: link_port,
            }
        }
        GridCommand::AddPort { node, role, side, medium } => {
            // Resolve the dense handle to a live NodeId (unknown -> reject).
            let node_id = view.resolve(node).ok_or(CommandError::UnknownNode)?;
            // Phase 76 (D-07): a label has no ports and never gains one. Checked first,
            // before the role and medium bytes are read; until this check the arm had no
            // kind check at all and grew a label a port.
            if is_label(view, node_id) {
                return Err(CommandError::LabelDoesNotConnect);
            }
            // Only a PLACED machine (one with a cell) is port-editable — a cell-less
            // Wire-minted belt / dangling id has no spatial body to grow (mirror the
            // fold's `cell_of(node).is_none()` no-op guard, T-36-04). No cell -> reject.
            let anchor = view.cell_of(node_id).ok_or(CommandError::UnknownNode)?;
            // The per-kind CATALOG box: `port_catalog(kind).0`, which the W1 base-parity
            // test pins EQUAL to the in-core `base_footprint(node)` the FOLD reads, so the
            // first-free-slot order here is the fold's.
            let kind = view.kind_of(node_id).ok_or(CommandError::UnknownNode)?;
            let base = port_catalog(kind).0;
            // The node's LIVE footprint, rotation included (WR-01): the geometry grows the
            // box on its far edges as turned, so the check must see the turn.
            let live_fp = view.footprint_of(node_id).unwrap_or(Footprint { w: 1, h: 1, rot: 0 });
            // Resolve the wire bytes to a typed Port (unknown role/medium -> UnknownOption since plan 88-02;
            // Side::from is total). `local_offset` is a placeholder: the geometry seats the
            // port at the first free slot of its role and on its role's edge (PORT-06:
            // medium=Electrical produces the first design-time WIRE port).
            let role = role_from_u8(role).ok_or(CommandError::UnknownOption)?;
            let medium = medium_from_u8(medium).ok_or(CommandError::UnknownOption)?;
            let port = Port { local_offset: (0, 0), side: Side::from(side), role, medium };
            let ports: Vec<Port> = view.ports_of(node_id).map(<[Port]>::to_vec).unwrap_or_default();
            // 73-03: THE APPEND POSITION is the `index` the record freezes. The user
            // gesture this arm serves is "add an output", which has always appended and
            // still does: the port is LISTED last (so it is the last routing key), while
            // since 74.1-16 it is SEATED on the first free slot. The field exists for the
            // INVERSE of a `RemovePort`, which is the only producer that ever names a
            // non-append slot.
            //
            // Clamped rather than unwrapped: a machine cannot legally hold more ports
            // than a `PortId` can name, and the footprint cap below rejects long before
            // that, but a saturating conversion is still the honest way to say so.
            let append_index = PortId::try_from(ports.len()).unwrap_or(PortId::MAX);
            // 74.1-16: THE FOLD'S OWN GEOMETRY, computed by the ONE shared function, so the
            // box checked here is byte for byte the box `fold_add_port` writes, at every
            // rotation (threat T-74.1-58). Until 74.1-16 this arm checked `grow_to_fit` at
            // the live anchor while the fold re-seated by list position; on a turned
            // machine the box the fold claimed differed from the one checked here.
            let geometry = add_port_geometry(
                base,
                anchor,
                live_fp,
                &ports,
                append_index,
                port,
                PortSeat::Auto,
            );
            // Reject a box whose UNCLAMPED size passes the dimension cap BEFORE the
            // geometry's clamp would leave a port outside it (the snapshot
            // PortOutOfFootprint reject-on-load / save-load data loss). Read off the
            // geometry, not off a role count: since 74.1-16 a list can hold holes, so a
            // count no longer bounds the slots. OutOfBounds, no new variant.
            let cap = i64::from(MAX_FOOTPRINT_DIM);
            if geometry.unclamped.0 > cap || geometry.unclamped.1 > cap {
                return Err(CommandError::MachineTooBig);
            }
            // ATOMICALLY bounds- + collision-check EVERY prospective cell at the
            // prospective anchor, EXCLUDING the node's OWN current cells (a cell it already
            // owns is not a self-collision, the Rotate self-exclusion). The FIRST off-grid
            // or foreign-occupied cell rejects the WHOLE add (state byte-identical, SC#2).
            // A belt tile is in the occupancy index too, so a growth over a docked belt's
            // end tile (the Fault's on a taller box, an Out's on a wider one) is refused
            // here, which is why an accepted add releases nothing.
            //
            // WHICH TAG (plan 74.1-18): the FIRST foreign cell of this walk decides, the
            // Rotate arm's rule. A BELT there is `GrowCoversBelt` ("Growing would cover a
            // belt. Move that belt first."), a machine stays `FootprintCollision`. The walk
            // and its order are untouched, so only the tag of an already-refused add moved.
            let fp = geometry.footprint;
            for c in cells_of_footprint(geometry.anchor, fp.w, fp.h, fp.rot) {
                if !in_bounds(c) {
                    return Err(CommandError::OutOfBounds);
                }
                if let Some(owner) = view.occupied_by(c)
                    && owner != node_id
                {
                    return Err(if covers_a_belt(view, owner) {
                        CommandError::GrowCoversBelt
                    } else {
                        CommandError::GrowBlocked
                    });
                }
            }
            // Accept: FREEZE the resolved AddPort with the forward seat. The fold
            // recomputes the same geometry VERBATIM on every replay.
            EditOp::AddPort { node: node_id, port, index: append_index, seat: PortSeat::Auto }
        }
        GridCommand::RemovePort { node, index } => {
            // Resolve the handle; a port-editable machine must have a cell.
            let node_id = view.resolve(node).ok_or(CommandError::UnknownNode)?;
            let _anchor = view.cell_of(node_id).ok_or(CommandError::UnknownNode)?;
            // Out-of-range index -> typed reject (a normalization failure), never a fold
            // that silently no-ops. A port-less node has len 0 so any index rejects.
            let port_count = view.ports_of(node_id).map_or(0, <[Port]>::len);
            if usize::from(index) >= port_count {
                return Err(CommandError::NoSuchPort);
            }
            // 73-12 (73-REVIEW CR-02): REFUSE a removal of a port a CABLE is attached to,
            // on either of the cable's endpoints.
            //
            // `fold_remove_port` re-points every wire endpoint ABOVE the removed port (a
            // wire endpoint is a raw catalog index, the same keyspace a Head dock uses) and
            // RELEASES the wire whose endpoint named the removed port itself, taking the
            // wire with it. The release is the right END STATE - the alternative is a
            // `Node::Wire` naming a port that does not exist, which `resolve_wire_dock`
            // degrades to the node origin (WINDOWS 116) - but it is NOT invertible from
            // here. Restoring a cable takes a `DrawWire` plus its captured incident links,
            // which is the `Delete` capture machinery; a `RemovePort` record carries none
            // of it, so an undo would return `Ok` and hand back a board missing a cable.
            //
            // THIS IS NOT THE 73-08 GATE COMING BACK. That gate was about BELT docks
            // (`own-dock` / `later-dock`), it lived in the frontend, and it stays deleted:
            // since 73-06 the core re-points and releases a belt and one Ctrl+Z restores
            // both. This is a CORE validate refusal about a case the core cannot invert,
            // and it changes the behaviour of no shipped gesture: MEASURED at 73-12, the
            // panel's port-edit controls are gated on `kind === machine_kind.FACTORY`
            // (`PortsSection.tsx`) while every machine that can carry a cable resolves to
            // HANDLER or ENDPOINT through `is_handler_shape` / `is_route_shape`, and no
            // production frontend path emits an `AddPort` with an electrical medium. So no
            // user gesture reaches this today; it is here for the phase that makes one.
            //
            // `PortOccupied` rather than a new tag: its shipped sentence is "That output is
            // already connected. Disconnect it first.", which is exactly the instruction,
            // and the panel offers Remove on outputs only. No eighteenth wire tag, no new
            // refusal copy row.
            if view.wire_touches_port((node_id, index)) {
                return Err(CommandError::PortOccupied);
            }
            // Since 74.1-16 a removal moves nothing: the footprint, the anchor and every
            // survivor's slot stay (design decision), so the cell set is unchanged and can
            // neither collide nor leave the grid. No bounds/collision check needed. Accept:
            // FREEZE the resolved RemovePort with no restore; the fold removes VERBATIM.
            EditOp::RemovePort { node: node_id, index, restore: None }
        }
        GridCommand::Configure { node, config } => {
            // Resolve the dense handle to a live NodeId (unknown -> typed reject, never
            // a panic). Unlike AddPort we do NOT require a cell or a KIND match: a
            // wrong-kind config folds to a panic-free no-op in `fold_configure`
            // (T-39-FOLD-PANIC), so the KIND is still not gated here.
            //
            // ROUTE-03 (65-04) narrowed this arm from resolve-only to resolve-plus-one
            // shape check. It does NOT contradict the paragraph above: the router
            // target-port check below asks whether the CONFIG names a port the board
            // does not have, which is a question about the config, not about the kind.
            let node_id = view.resolve(node).ok_or(CommandError::UnknownNode)?;
            // Convert first: the check needs the CORE shape, and `wire_config_to_core`
            // takes only the wire config, so it has neither this view nor `node_id` and
            // structurally cannot host the check.
            let core_config = wire_config_to_core(config)?;
            // ROUTE-03 target-port check. A routing table naming an output the node does
            // not have used to fold successfully: the router pushed onto an outbox no
            // belt drains, and every item routed there vanished with no message, through
            // a certified and replayable record. Refused HERE instead, before any record
            // exists, in the `RemovePort` arm's shape (:1167) and returning the SAME
            // typed variant it returns for an index past the port list. Same class, same
            // tag: no eighteenth wire tag, no new refusal copy row.
            //
            // THE BOUND IS A COUNT OF `Role::Out` PORTS, NEVER `ports.get(port)`.
            // A rule's port and the default are ROUTING KEYS; a catalog index is a
            // different keyspace, and on a Router the two collide numerically. See
            // `dock_link_key`'s "Two keyspaces that genuinely collide" docblock (:665)
            // for the one translation between them, and `bless_fixtures.rs`'s
            // `author_router_config` for the same warning stated from the authoring
            // side. An index lookup here typechecks and is wrong.
            //
            // Three decisions, settled, each with its reason, so the next reader does
            // not undo one of them as a supposed fix:
            //
            // 1. IT RUNS ON THE CONFIG'S SHAPE, NOT ON THE NODE'S KIND. A `Router`
            //    table aimed at a Factory used to fold to a panic-free no-op and is now
            //    refused. That is deliberate: refusing a no-op is strictly better than
            //    accepting one, and the question the check asks is true regardless of
            //    kind. Every NON-Router config shape is untouched and stays a
            //    resolve-only accept.
            // 2. `default: Some(FAULT_PORT)` IS REFUSED like any other out-of-range key.
            //    `FAULT_PORT` is `u16::MAX`, the top of the `PortId` space, and is a
            //    RESERVED routing key with no `Port` record (`fault.rs`, Assumption A4),
            //    so a count-based bound rejects it for free. The accepted set is the
            //    contiguous range `0 ..< out_count` with no sentinel hole, and no
            //    shipped panel emits the reserved value.
            // 3. THE TARGET-PORT HALF IS A COMMAND-TIME ACCEPT-ENVELOPE NARROWING
            //    ONLY, never a load-time guarantee. The core fold never re-validates
            //    (decision Q2), so an `EditOp::Configure` loaded from a saved project or
            //    replayed from a log does not pass through this arm at all: a forged
            //    `.fab` naming port 99 still loads. The SIZE half below is different in
            //    kind: it exists precisely so the two boundaries AGREE (see 4).
            // 4. THE SIZE BOUND IS NOT A DUPLICATE OF A LOAD-TIME GUARD. IT IS THE
            //    MISSING WRITE-SIDE HALF OF ONE.
            //    An earlier version of this docblock said the size bounds `MAX_ROUTES`
            //    and `MAX_ROUTE_EXPECT_BYTES` were "applied at the `edit::upcast` decode
            //    boundary and again at `fabrico_host::project::load_project`", and used
            //    that as the reason not to state them here. HALF OF THAT WAS FALSE, and
            //    the false half is the load-bearing one. `fabrico_core::edit::upcast`
            //    has NO production caller: it says so itself in its own docblock, and
            //    `fabrico_host::project.rs` repeats it ("`edit::upcast` is NOT a
            //    boundary any caller reaches"). Every `upcast(` call site outside
            //    `event.rs` is a test. So before this check existed, the ONLY live
            //    enforcement of either constant was `load_project`'s per-record loop
            //    (`project.rs`, `EditRouteTableTooLong` / `EditRoutePatternTooLong`),
            //    and that is LOAD-SIDE ONLY.
            //
            //    A load-side-only bound on a value that ONLY THE USER CAN AUTHOR is a
            //    trap, not a guard. The Match-text field is a free-text input with no
            //    clamp, so a 1025-byte pattern was accepted here, folded, written to the
            //    certified edit log, and saved -- and the saved bundle then permanently
            //    refused to load with `EditRoutePatternTooLong`. Reproduced end to end:
            //    command `Ok(())`, `save_project` `Ok(())`, `load_project` `Err(..)`.
            //    The user's work was gone with no way back.
            //
            //    The rule this arm now keeps: NOTHING THE COMMAND LAYER ACCEPTS CAN BE
            //    REFUSED BY `load_project`. Both sides read the SAME two constants out
            //    of `fabrico_core::edit` (never restated numbers), so the bound has one
            //    home and two typed refusals, exactly as `MAX_FOOTPRINT_DIM` already
            //    does. A `maxLength` on the React input is defence in depth on top of
            //    this, never the guard: the wire is reachable without the panel.
            if let MachineConfig::Router { routes, default } = &core_config {
                // SIZE FIRST, targets second. The target walk below is O(routes), so a
                // forged multi-million-rule table should be refused before it is walked
                // rather than after. The order is not otherwise observable: both halves
                // return the SAME typed variant.
                if routes.len() > MAX_ROUTES
                    || routes
                        .iter()
                        .any(|(key, _)| key.expect.len() > MAX_ROUTE_EXPECT_BYTES)
                {
                    return Err(CommandError::OverLimit);
                }
                let out_count = view
                    .ports_of(node_id)
                    .map_or(0usize, |ps| ps.iter().filter(|p| p.role == Role::Out).count());
                let addressable = |port: PortId| usize::from(port) < out_count;
                if !routes.iter().all(|(_, port)| addressable(*port))
                    || !default.is_none_or(addressable)
                {
                    return Err(CommandError::NoSuchPort);
                }
            }
            // SERVE-08 (72-07, R-47): the Route path's four rules, ALL FOUR APPLIED
            // HERE, at the WRITE gate, because this is the authority.
            //
            // THE FRONTEND GATE IS A COURTESY AND THIS IS THE AUTHORITY. Plan 72-10
            // gives the config panel its own check with a mirrored bound, and from this
            // side that check is untrusted input: the wire is reachable without the
            // panel, exactly as the `maxLength` note on the router pattern field above
            // records for its own bound. `route_url_and_fault.rs`'s
            // `a_malformed_path_is_refused_by_the_core_alone` drives a bad path straight
            // through this seam with no frontend in the loop, which is what proves the
            // sentence above rather than asserting it.
            //
            // WHY THE SPLIT INTO A PREDICATE PLUS ONE LOOKUP. Rules 1 to 3 (a leading
            // slash with something after it, the length bound, unreserved bytes only)
            // are a pure question about the STRING and live in ONE place,
            // `fabrico_core::edit::endpoint_path_is_valid`, so the core, this gate and
            // the frontend mirror all ask the same question of the same bytes. Rule 4
            // (uniqueness) is the only one that needs the whole BOARD, which is why it
            // is a `GridLookup` method and why `wire_config_to_core` structurally could
            // not host it.
            //
            // WHY RULE 4 HAS ITS OWN TAG AND THE OTHER THREE DO NOT. It is the only rule
            // that can name a specific OTHER OBJECT. Rules 1 to 3 share `InvalidPath`
            // (split out of `Malformed` by plan 88-02, D-11), whose sentence is about the
            // address itself; "another Route already answers
            // there" is not a statement about malformed input at all. The tag carries
            // the authority, the panel carries the owner's name (D-13).
            //
            // ORDER: shape first, uniqueness second. The uniqueness walk is O(nodes), so
            // a malformed string is refused before the board is walked. The order is not
            // otherwise observable, since the two return different tags on disjoint
            // inputs.
            //
            // WRITE-SIDE ONLY, like the belt-pace range above and for the same reason
            // (D-68-17). The fold never re-validates (Q2), so a saved project or a
            // replayed log carrying a path this gate would refuse still LOADS and still
            // REPLAYS. What is NOT write-side-only is the LENGTH: that one is an
            // allocation guard and is enforced again at `edit::upcast` and at
            // `snapshot::restore`, all three reading `MAX_ENDPOINT_PATH_BYTES`. The
            // distinction is the same one `PaceOutOfRange` draws between a UI range
            // choice and a data invariant, and getting it backwards is how a UI rule
            // becomes a save-breaking change.
            if let MachineConfig::Endpoint { path } = &core_config {
                if !fabrico_core::edit::endpoint_path_is_valid(path) {
                    return Err(CommandError::InvalidPath);
                }
                // `node_id` is EXCLUDED: a Route re-applying its OWN committed path is
                // not a duplicate, and without that clause this would refuse a user who
                // opens the panel and presses Apply twice.
                if view.endpoint_path_owner(path, node_id).is_some() {
                    return Err(CommandError::DuplicatePath);
                }
            }
            // Phase 76 (plan 76-02, D-04, SHAPE-13 write half): A LABEL'S WORDS, COLOUR
            // AND SIZE, refused here in this order, each before any record exists:
            //
            // 1. A Label config aimed at a NON-label is `WrongKind` (`Malformed` until 88-02). Unlike the shipped
            //    kinds, whose wrong-kind Configure is a fold no-op (T-39-FOLD-PANIC), this
            //    one is REFUSED: refusing a no-op is strictly better than accepting one
            //    (the Router target-port check's decision 1), and no shipped panel sends
            //    one.
            // 2. Text over `MAX_LABEL_BYTES` is `OverLimit`, reading the ONE constant the
            //    TypeScript mirror is locked to. Bytes, not characters.
            // 3. A width or depth outside `1..=MAX_FOOTPRINT_DIM` is `OverLimit`, and a
            //    width or depth that CHANGES must also lie in `1..=LABEL_MAX_W` /
            //    `1..=LABEL_MAX_H` (plan 86-07, D-09, WORK-11). The panel cap is a
            //    WRITE-side UI policy (see `LABEL_MAX_W`) and the panel's Apply always
            //    resends the current size, so applying it to an unchanged side froze any
            //    label past it: a board from a later build with a larger cap, or a
            //    hand-edited one, could never take new words or a new colour. Per side, so
            //    a 17 by 9 label may narrow to 16 while keeping depth 9; a grow past the
            //    cap is still refused, and the fold's envelope stays the absolute bound.
            // 4. Every cell of the NEW box, anchored at the label's top-left cell (a label
            //    grows right and down), is walked in the Rotate arm's shape: a cell past
            //    the grid edge is `OutOfBounds`, a cell another node holds is
            //    `ResizeCovers`. The label's OWN cells are excluded, so re-applying the
            //    committed size, or shrinking, never collides with itself.
            //
            // The box the fold claims is exactly this box: `resize_label_box` writes the
            // same anchor and the same `w` by `h` at rot 0 (the clamp there never bites a
            // value that passed check 3).
            if let MachineConfig::Label { text, w, h, .. } = &core_config {
                if view.kind_of(node_id) != Some(machine_kind::LABEL) {
                    return Err(CommandError::WrongKind);
                }
                let current = view.footprint_of(node_id).unwrap_or(Footprint { w: 1, h: 1, rot: 0 });
                let side_ok = |next: u16, now: u16, cap: u16| {
                    (1..=MAX_FOOTPRINT_DIM).contains(&next) && (next == now || (1..=cap).contains(&next))
                };
                if text.len() > fabrico_core::edit::MAX_LABEL_BYTES
                    || !side_ok(*w, current.w, LABEL_MAX_W)
                    || !side_ok(*h, current.h, LABEL_MAX_H)
                {
                    return Err(CommandError::OverLimit);
                }
                let anchor = view.cell_of(node_id).ok_or(CommandError::UnknownNode)?;
                for c in cells_of_footprint(anchor, *w, *h, 0) {
                    if !in_bounds(c) {
                        return Err(CommandError::OutOfBounds);
                    }
                    if let Some(owner) = view.occupied_by(c)
                        && owner != node_id
                    {
                        return Err(CommandError::ResizeCovers);
                    }
                }
            }
            // Freeze the resolved Configure with a ZEROED code_hash: the command layer
            // is blake3-fenced (A3 / T-39-FENCE) and NEVER computes the hash: the host
            // (Phase 39-04) stamps the real blake3 of the exact Factory JS bytes. The
            // wire config was converted above to the byte-identical core shape (variant
            // order is load-bearing, see `wire_config_to_core`), which is also fallible
            // since 63-04: a wire-side `Belt{ticks_per_slot: 0}` is refused there with a
            // typed error and produces NO record (SC#2), rather than being defaulted
            // into a speed the user did not choose.
            EditOp::Configure {
                node: node_id,
                config: core_config,
                code_hash: [0u8; 32],
            }
        }
        GridCommand::DrawWire {
            from_node,
            from_port,
            to_node,
            to_port,
        } => {
            // WIRE-01 — the ONE endpoint-legality gate for a wire. Sequenced exactly
            // as the `Dock` arm above sequences its checks (resolve -> role -> medium
            // -> occupancy), because a different order returns a DIFFERENT typed error
            // for the same input, and the two arms are meant to be readable as one
            // rule applied two ways.
            //
            // Everything is decided HERE, before the record is appended: the core fold
            // never re-validates (decision Q2), so `fold_draw_wire` applies whatever
            // this arm freezes, verbatim.

            // (1) Resolve both dense handles to live NodeIds (stale/forged -> typed
            //     reject, never a panic).
            let from_id = view.resolve(from_node).ok_or(CommandError::UnknownNode)?;
            let to_id = view.resolve(to_node).ok_or(CommandError::UnknownNode)?;
            // (1b) Phase 76 (D-07): a label at EITHER end is refused by name before the
            //      ports are read, because a label has none and the port sentences below
            //      would tell the user to aim at one.
            if is_label(view, from_id) || is_label(view, to_id) {
                return Err(CommandError::LabelDoesNotConnect);
            }
            // (2) A self-loop is LEGAL at the fold (it mints a wire whose request
            //     would leave and re-enter one node), so it has to be stopped here or
            //     nowhere. `IncompatiblePorts` already carries exactly this meaning.
            if from_id == to_id {
                return Err(CommandError::IncompatiblePorts);
            }
            // (3) to (6) for the leg the user actually dragged: ports, roles, medium and
            //     occupancy, in [`resolve_wire_leg`]. It is asked FIRST and
            //     unconditionally, so a drag that is illegal in its own right is refused
            //     with its own typed tag before the pairing is even considered - a drag
            //     released on a Handler's mechanical Fault nub is `IncompatiblePorts`
            //     whether or not the two machines pair.
            let dragged = resolve_wire_leg(view, from_id, from_port, to_id, to_port)?;

            // (7) THE PAIRING (D-04, R-50/R-51/R-52). When the drag joins a Route and a
            //     Handler, ONE command mints BOTH cable legs, because D-06 is an
            //     invariant and not a convenience: as `72-CLEAN-DESIGN`'s walk step 6 was
            //     written, a POST succeeds with only the FORWARD cable drawn, since the
            //     host resolves the parked socket from the correlation alone
            //     (`sim_loop.rs:594-601`). A return cable that can be absent while
            //     everything still works is a decorative cable, and a board that lies.
            //     D-04 removes the problem by construction: THERE IS NO BOARD STATE IN
            //     WHICH THE FORWARD CABLE EXISTS WITHOUT ITS RETURN LEG.
            match route_handler_pair(view, from_id, to_id) {
                Some((route, handler)) => {
                    // BOTH legs are derived from the two nodes' DECLARATIONS, and the
                    // drag's own ports are discarded here. Direction of the drag does
                    // not matter (R-51): a drag that started on the Handler's Out mints
                    // the identical two wires as one that started on the Route's Out,
                    // in the identical order, so the pair is the same two `NodeId`s
                    // either way.
                    let (Some(route_out), Some(route_in)) = (
                        first_electrical_port(view, route, Role::Out),
                        first_electrical_port(view, route, Role::In),
                    ) else {
                        return Err(CommandError::IncompatiblePorts);
                    };
                    let (Some(handler_out), Some(handler_in)) = (
                        first_electrical_port(view, handler, Role::Out),
                        first_electrical_port(view, handler, Role::In),
                    ) else {
                        return Err(CommandError::IncompatiblePorts);
                    };
                    // WHOLE OR NOTHING (R-52). Both legs run through EVERY check the
                    // single leg runs, against the SAME pre-fold view, and the `?` on
                    // either refuses the WHOLE command having produced nothing. The two
                    // legs leave DIFFERENT output ports, so validating both against one
                    // view is exact rather than approximate: neither leg can occupy the
                    // other's source port.
                    //
                    // The reachable refusal is the second Route: with D-02's single
                    // electrical Out, `handler_out` is already carrying the first Route's
                    // answer, so the RETURN leg is refused `PortOccupied` and the forward
                    // leg is NOT minted. Refusing the forward leg too is the entire point
                    // - a lone forward cable is the forward-only board D-06 rules
                    // unreachable, and it would otherwise be reachable through an
                    // ordinary user gesture within a minute of placing a second Route.
                    //
                    // FORWARD FIRST, RETURN SECOND, always, whichever way the user
                    // dragged. Fold order decides which leg gets the lower minted
                    // `NodeId`, so a canonical order is what makes the two drag
                    // directions produce byte-identical boards.
                    let forward = resolve_wire_leg(view, route, route_out, handler, handler_in)?;
                    let ret = resolve_wire_leg(view, handler, handler_out, route, route_in)?;
                    paired = Some(ret);
                    forward
                }
                // Every other electrical pair mints ONE wire exactly as it did before
                // 72-08: the dragged leg, verbatim. See `route_handler_pair` for why
                // that is correctness and not scope.
                None => dragged,
            }
        }
        GridCommand::Unlink { belt, endpoint, node, port } => {
            // CONNECT-01 — the explicit DISCONNECT verb. Before Phase 63
            // `EditOp::Unlink` was reachable only from inside `compute_inverse`, as a
            // `Dock`'s computed inverse; this arm is the first thing that lets a
            // client ask for one.
            //
            // (1) Resolve both dense handles (stale/forged -> typed reject, never a
            //     panic), mirroring the Dock arm's resolve-first sequence.
            let belt_id = view.resolve(belt).ok_or(CommandError::UnknownNode)?;
            let node_id = view.resolve(node).ok_or(CommandError::UnknownNode)?;
            let core_end = match endpoint {
                fabrico_protocol::BeltEnd::Head => BeltEnd::Head,
                fabrico_protocol::BeltEnd::Tail => BeltEnd::Tail,
            };
            // (2) Resolve the port to the LINK KEY `fold_dock` wrote, through the same
            //     two helpers the Dock arm calls. NO geometry is re-checked: a rotate
            //     or a footprint change may well have moved the machine since the dock,
            //     and a disconnect must stay reachable for exactly the links that are
            //     hardest to reason about. NO medium check either — the carrier is
            //     already attached; its legality was decided when it was.
            let mports = view.ports_of(node_id);
            let link_port = match resolve_spatial_port(mports, port) {
                Some(idx) => {
                    // (2a) The DIRECTION rule, applied exactly as the Dock arm applies
                    //      it: a Head (load) unlink names a machine `In`, a Tail
                    //      (offload) unlink names an `Out` or the `Role::Fault` output.
                    //
                    //      This is the ONE place this arm is stricter than "resolve
                    //      only", and the reason is a real collision rather than
                    //      tidiness: a ROUTER's In has catalog index 0 and its Out has
                    //      routing key 0, so a Tail unlink naming catalog 0 would,
                    //      carried through untranslated, remove the live Out link the
                    //      user did not name. Refusing on the role is what keeps the
                    //      two numbers from aliasing. An index naming no declared port
                    //      is refused for the same reason: it can only ever freeze a
                    //      key that folds to a no-op, and a silent no-op reported as
                    //      success is the failure shape this phase exists to avoid.
                    let mport = mports
                        .and_then(|ports| ports.get(idx as usize))
                        .copied()
                        .ok_or(CommandError::InvalidDock)?;
                    let role_ok = match core_end {
                        BeltEnd::Head => mport.role == Role::In,
                        BeltEnd::Tail => matches!(mport.role, Role::Out | Role::Fault),
                    };
                    if !role_ok {
                        return Err(CommandError::InvalidDock);
                    }
                    dock_link_key(mports.unwrap_or(&[]), idx)
                }
                // The NON-spatial fault sentinel (a node whose fault output has no
                // perimeter nub). Offload-only, mirroring the Dock arm's WR-04 guard:
                // errors flow OUT of a fault port, so no Head link was ever created
                // there and no Head unlink can name one.
                None if core_end == BeltEnd::Tail => FAULT_PORT,
                None => return Err(CommandError::InvalidDock),
            };
            // Accept. Unlinking a link that does NOT exist is deliberately ACCEPTED
            // here and folds to a panic-free no-op: `GridState::unlink` of an absent
            // key is documented safe (strictly safer than `fold_dock`'s missing-node
            // guard), and refusing it would need validate to read the live `links` map
            // — a second accept envelope for one gesture, and the `Configure` arm's
            // resolve-only precedent says not to build one. Pinned by
            // `unlink_of_an_absent_link_is_accepted_and_folds_to_a_noop`.
            EditOp::Unlink {
                belt: belt_id,
                endpoint: core_end,
                node: node_id,
                port: link_port,
            }
        }
        // The undo/redo commands are NEVER validated/normalized — they are routed
        // away by [`GridSession::apply`] BEFORE this function is reached, and produce
        // their FROZEN compensating records directly via `undo()`/`redo()` (the
        // ELOG-02 crux, Q4.2: the Undo/Redo command is never stored, only its
        // resolved inverse records are). A standalone caller that hands them to
        // `validate_normalize` gets a typed reject (never a panic) — they have no
        // valid resolved-record form. This arm keeps the `match cmd` exhaustive.
        GridCommand::Undo | GridCommand::Redo => return Err(CommandError::Malformed),
    };

    // The group, in FOLD ORDER: the primary record then, for the two paired arms only,
    // its second leg, then (a turn only, D-08) the docks the turn makes, which fold after
    // the Rotate so they meet the ports where the turn put them. Every record carries the
    // SAME provenance placeholders, and the caller stamps ONE action id across the whole
    // group - which is what makes a paired draw, a paired delete or a turn and its docks
    // ONE undo step (D-04, D-08).
    Ok(std::iter::once(op)
        .chain(paired)
        .chain(extra)
        .map(|op| EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            // Provenance fields are stamped by GridSession::apply; placeholders here.
            partition: 0,
            sequence: 0,
            tick: 0,
            action: 0,
            op,
        })
        .collect())
}

/// The headless grid driver — builds a grid end-to-end from [`GridCommand`]s with
/// NO renderer and NO host present (SC#1/CMD-01).
///
/// A session owns a deterministic [`Core`] (the folded topology), the append-only
/// edit-log of RESOLVED records, the read-only [`GridView`] projection it validates
/// against, and the monotonic provenance counters. [`apply`](Self::apply) is the ONE
/// way the grid changes: validate → stamp → append → fold → re-project. The grid is
/// NEVER written speculatively — every mutation flows through `Core::advance_edits`
/// on the logged record (CMD-05).
///
/// # Tick-stamping discipline (the ELOG-02 replay-equivalence contract, W3)
/// Each `apply` stamps `record.tick = core.tick` and folds it via `advance_edits`,
/// which applies the record AT `core.tick` then advances to `tick + 1`. So each
/// `apply` is its own tick and the stamped `record.tick` ALWAYS equals the tick the
/// fold applied it at. Replaying the edit-log via `Core::run_log_two_logs` therefore
/// regroups records by the SAME stamped tick and reproduces a byte-identical `Core`
/// (no tick divergence) — proven by `edit_log_replays_byte_identical`.
pub struct GridSession {
    /// The deterministic core (topology = a pure projection of the edit-log).
    core: Core,
    /// The append-only log of RESOLVED edit-records (the ELOG-02 source of truth).
    edit_log: Vec<EditRecord>,
    /// The append-only log of RUNTIME events ([`pump`](Self::pump)'s SECOND log):
    /// `ManualInject` and other runtime inputs, stamped at `core.tick` with a
    /// monotonic event-sequence. This is the second cursor `run_log_two_logs` folds
    /// EDITS-FIRST on replay (the TEST-05 "build then run" seam). Distinct from
    /// `edit_log` (topology) and on its OWN sequence space (`event_sequence`).
    event_log: Vec<Event>,
    /// The read-only projection `apply` validates against (folded from `edit_log`).
    view: GridView,
    /// Monotonic per-record sequence (the ROUTE-06-style tie-break id).
    sequence: u64,
    /// Monotonic per-event sequence ([`pump`](Self::pump)'s tie-break id). Events
    /// live in their OWN sequence space, parallel to the edit `sequence`/`action`
    /// counters (the two logs never share a sequence — they are separately ordered).
    event_sequence: u64,
    /// Monotonic per-command coalescing-group id. In Phase 8 one command = one
    /// record = one action (Phase-12 coalescing groups multi-record actions).
    action: u64,
    /// The genesis seed, threaded so the undo/redo projection's pure re-fold
    /// (`reconstruct_projection`) and [`replay`](Self::replay) rebuild the SAME
    /// deterministic core the live session folded (slotmap minting is seed-
    /// independent, but the seed keeps the throwaway re-fold a faithful pure
    /// function of `(seed, edit_log)`).
    seed: u64,
    /// The undoable-action stack (12-RESEARCH Pattern 4): normal action ids in
    /// append order (the currently-live PLUS the redoable tail). A STRICT
    /// projection of `edit_log` — always equal to a fresh fold (proven by the
    /// `redo_cursor_equals_fold` proptest).
    undoable: Vec<u64>,
    /// The linear redo cursor: the count of currently-LIVE actions. The half-open
    /// range `cursor..undoable.len()` is the undone/redoable tail (Q1.1 linear
    /// history). `can_undo = cursor > undo_floor`; `can_redo = cursor < undoable.len()`.
    cursor: usize,
    /// The UNDO FLOOR (plan 85-06, D-10, DEMO-05): the cursor at the last
    /// [`EditOp::SealHistory`] record in the log, `0` when the log holds none. Nothing at
    /// or below it is undoable: those are a seeded scene's own commands, and the user did
    /// not make them. Rebuilt ONLY by
    /// [`reconstruct_projection`](Self::reconstruct_projection), from the logged seal, so
    /// it is a pure function of the log like `undoable` and `cursor`: a replay, a reopen
    /// and the live fold all compute the same floor (`redo_cursor_equals_fold` compares
    /// it). Never serialized as a field of its own; the seal record IS its persistence.
    undo_floor: usize,
    /// Whether the log's undo records reach BELOW its floor (plan 85-06, D-10, T-85-14):
    /// an Undo marker naming an action at a position under the floor, or the cursor
    /// stepped below the floor at any point of the walk. No log this build writes does
    /// either, because Undo is refused at the floor; only a hand-edited or damaged `.fab`
    /// can. Rebuilt only by [`reconstruct_projection`](Self::reconstruct_projection);
    /// read through [`undo_floor_breached`](Self::undo_floor_breached), which
    /// `load_project` refuses on.
    undo_floor_breach: bool,
    /// Whether the log holds a record that joins a label to anything (plan 86-07, D-08,
    /// WORK-09): an `AddPort` on a label, a `Dock` to one, or a `DrawWire` with a label at
    /// either end. The fold changes nothing on such a record and names the label in
    /// `last_tick.refused_label_connects`; this walk is the one place that sees EVERY
    /// bundled record from genesis (the load's core replay skips edits before its base
    /// snapshot). No log this build writes holds one, because validation refuses the
    /// gesture first; only a hand-edited or damaged `.fab` can. Rebuilt only by
    /// [`reconstruct_projection`](Self::reconstruct_projection); read through
    /// [`label_connect_forged`](Self::label_connect_forged), which `load_project` refuses on.
    label_connect_forged: bool,
    /// The id-translation map: original-minted [`NodeId`] -> current live `NodeId`
    /// across undo/redo re-mints (identity until a re-mint). A `BTreeMap` (ordered,
    /// deterministic iteration) — NEVER a `HashMap` in the command/sim path
    /// (determinism constraint). Used only to retarget frozen inverse records at
    /// undo/redo issue time (the 12-04 driver); never persisted, always rebuilt by
    /// the fold.
    xlate: BTreeMap<NodeId, NodeId>,
    /// The originally-minted [`NodeId`]s per NORMAL action id, in mint order (a pure
    /// projection of `edit_log`, rebuilt by [`reconstruct_projection`]). The undo
    /// driver (12-04) reads `original_placed[target]` to recover which ids the target
    /// action minted, then maps each through [`xlate`] to the CURRENT live id to build
    /// the frozen inverse `Delete`s (Pattern 2 + Pitfall 1). Deterministic `BTreeMap`,
    /// never a `HashMap` in the command path.
    original_placed: BTreeMap<u64, Vec<NodeId>>,
    /// The port each `RemovePort` record removed, keyed by that record's
    /// `(action, sequence)` — the NON-SERIALIZED undo-capture (PORT-07). A sibling of
    /// [`original_placed`](Self::original_placed): NEVER serialized (like `xlate`),
    /// rebuilt PURELY by [`reconstruct_projection`](Self::reconstruct_projection)'s
    /// throwaway re-fold, which reads `ports_of(node)[index]` on the fresh core JUST
    /// BEFORE each `RemovePort` folds (the port is still live). `compute_inverse` looks
    /// the removed [`Port`] up here to invert a `RemovePort` back to an `AddPort` — so
    /// undo of a remove survives save/load with ZERO serialized `captured` field
    /// (identical durability to `xlate`/`original_placed`). Deterministic `BTreeMap`.
    ///
    /// # 73-03: the value is `(Port, PortId)` - the port AND the slot it came out of
    /// The `Port` alone was enough only while `fold_add_port` could do nothing but
    /// append. `EditOp::AddPort` now carries an `index`, so the inverse must say WHICH
    /// slot to put the port back into, and this is where that answer is read from. The
    /// index is captured in the same read that captures the port, from the same live
    /// list, so the two cannot disagree.
    removed_ports: BTreeMap<(u64, u64), (Port, PortId)>,
    /// The PRIOR effective [`MachineConfig`] each record that CHANGED one overwrote,
    /// keyed by that record's `(action, sequence)` — the NON-SERIALIZED undo-capture for
    /// CFG-02, the exact `removed_ports` (PORT-07) analog. NEVER serialized (like
    /// `xlate`), rebuilt PURELY by
    /// [`reconstruct_projection`](Self::reconstruct_projection)'s throwaway re-fold,
    /// which reads the node's CURRENT config JUST BEFORE the record folds:
    /// `Factory.source`/`Sink.template` from the fresh core state, and the Source
    /// trigger from a running last-trigger map (default [`SourceTrigger::Webhook`])
    /// since a Source config is a core no-op that never touches state. `compute_inverse`
    /// looks the prior config up here to invert back to a `Configure` carrying it — so
    /// undo survives save/load with ZERO serialized field. Deterministic `BTreeMap`.
    ///
    /// # THREE record kinds write here; the second one is why this docblock was
    /// # REWRITTEN WHOLE rather than appended to (73-12, 73-REVIEW CR-01)
    /// Until 73-12 this map held the prior config of a `Configure` and nothing else, and
    /// the sentence above said so. That is now FALSE and the old wording is deleted
    /// rather than annotated, on this repository's own recorded rule (`project.rs`'s
    /// version table). The contract is the wider one it always described in spirit:
    /// **the effective config a record was about to change, read before it folded.**
    ///
    /// - `Configure` writes it because the record REPLACES the config outright (CFG-02).
    /// - `RemovePort` on a `Node::Router` writes it because
    ///   [`fold_remove_port`](fabrico_core::tick) re-points `Router.routes` and
    ///   `Router.default` as a DERIVED consequence of the port list shrinking, and one
    ///   arm of that re-point is information-DESTROYING: a rule naming the removed
    ///   output is dropped and a `default` naming it becomes `None`. `fold_add_port`'s
    ///   mirror only shifts keys, so it can neither re-create a dropped rule nor un-clear
    ///   a cleared default. Before this capture existed, one Ctrl+Z after removing an
    ///   output returned `Ok(())`, restored the port and every dock, and handed back a
    ///   board silently short one routing rule and its fallback (73-REVIEW CR-01).
    ///
    /// - `Delete` of a `Node::Label` (76-05, D-08) writes the label's FULL config, its
    ///   words, colour and box, because the Delete inverse re-`Place`s the box from the
    ///   record's `captured` w and h but `DeletedSubgraph` carries neither the words nor
    ///   the colour. The Delete inverse reads this entry and re-`Configure`s the
    ///   re-minted label with it. A `Delete` of any other kind writes nothing here.
    ///
    /// A `RemovePort` on a NON-Router writes nothing here, so a capture MISS on that arm
    /// is ordinary rather than a misalignment — which is why `compute_inverse`'s
    /// `RemovePort` arm must NOT copy the `Configure` arm's capture-miss REFUSAL. That
    /// difference is stated at both sites. The same holds for a `Delete`: a miss there
    /// restores the label at its defaults, never refuses.
    prior_configs: BTreeMap<(u64, u64), MachineConfig>,
    /// The LIVE-AUTHORITATIVE twin of [`removed_ports`](Self::removed_ports): the port
    /// each `RemovePort` removed, read from the REAL `self.core` in
    /// [`capture_before_fold`](Self::capture_before_fold) at fold time, keyed by that
    /// record's `(action, sequence)`. NEVER serialized (a sibling of `xlate` /
    /// `original_placed` / `removed_ports`). Carries the slot index alongside the port
    /// since 73-03, for the reason written on its re-fold twin.
    ///
    /// # Why a second map instead of just fixing the re-fold
    /// `reconstruct_projection`'s throwaway `Core::genesis(seed)` can only ever see
    /// nodes MINTED BY THE EDIT LOG. A live session whose core holds nodes the log never
    /// minted (a core built by hand through `core_mut`, or a hand-edited file whose saved
    /// board holds more than its log describes; every shipped scene is log-only since plan
    /// 85-08) has a live slotmap allocator running ahead of the throwaway one, and
    /// `fresh.state.ports_of(LIVE_id)` returns `None`.
    /// The re-fold capture is therefore a BEST-EFFORT reconstruction, correct only when
    /// the log is the sole minter; the live read is authoritative BY CONSTRUCTION,
    /// because it reads the very core the record is about to fold against.
    ///
    /// A session that never folds live keeps this map EMPTY, so its projection is
    /// byte-identical to the pre-fix behaviour (see the merge in
    /// [`reconstruct_projection`](Self::reconstruct_projection)).
    live_removed_ports: BTreeMap<(u64, u64), (Port, PortId)>,
    /// The box and anchor each `AddPort` record grew FROM, keyed by that record's
    /// `(action, sequence)`: the NON-SERIALIZED undo-capture of plan 74.1-16, in the exact
    /// shape of [`removed_ports`](Self::removed_ports). NEVER serialized, rebuilt PURELY by
    /// [`reconstruct_projection`](Self::reconstruct_projection)'s throwaway re-fold, which
    /// reads the node's footprint and anchor JUST BEFORE each `AddPort` folds.
    ///
    /// `compute_inverse` reads it to invert an `AddPort` into a `RemovePort` carrying
    /// `restore: Some(captured)`, so one Ctrl+Z of an add that grew the box shrinks it
    /// and, on a turned machine, moves the anchor back. Since 74.1-16 a forward removal
    /// never shrinks, so without this capture the box could never come back.
    ///
    /// Written for every `AddPort` on a node with a cell. A capture MISS on a LIVE node
    /// therefore means the projection lost id alignment, and `compute_inverse` refuses the
    /// group as `UndoDoesNotFit`, the `removed_ports` policy.
    added_port_boxes: BTreeMap<(u64, u64), BoxRestore>,
    /// The LIVE-AUTHORITATIVE twin of [`added_port_boxes`](Self::added_port_boxes), read
    /// from the REAL `self.core` in [`capture_before_fold`](Self::capture_before_fold) and
    /// merged live-wins at the tail of `reconstruct_projection`, for the reason written on
    /// [`live_removed_ports`](Self::live_removed_ports). NEVER serialized.
    live_added_port_boxes: BTreeMap<(u64, u64), BoxRestore>,
    /// The LIVE-AUTHORITATIVE twin of [`prior_configs`](Self::prior_configs): the PRIOR
    /// effective [`MachineConfig`] each `Configure` overwrote (and, since 76-05, each
    /// deleted label's config, through the same [`capture_slice`] call), read from the REAL
    /// `self.core` in [`capture_before_fold`](Self::capture_before_fold), keyed by that
    /// record's `(action, sequence)`. NEVER serialized. Same rationale as
    /// [`live_removed_ports`](Self::live_removed_ports): `fresh.state.node(LIVE_id)`
    /// misses entirely once the core holds a node the edit log never minted, so the re-fold
    /// capture silently produces nothing and the Configure inverse skips.
    live_prior_configs: BTreeMap<(u64, u64), MachineConfig>,
    /// The LIVE-AUTHORITATIVE twin of [`original_placed`](Self::original_placed): the
    /// [`NodeId`]s each action actually minted, in mint order, harvested from the REAL
    /// `core.last_tick.placed` in [`capture_after_fold`](Self::capture_after_fold).
    /// NEVER serialized.
    ///
    /// The throwaway re-fold harvests ids from its OWN allocator, which runs behind the
    /// live one by exactly the number of nodes the log never minted, so a Place's
    /// inverse `Delete` named a real but WRONG live node (on the shipped demo of the
    /// time, a cable of its request pair), destroying it while leaving the placed machine
    /// standing. Reading `last_tick.placed` on the live core is correct by construction:
    /// only the three MINTING folds (`fold_place`, `fold_draw_belt` and, since 63-02,
    /// `fold_draw_wire`) push into it, so direct `state.add_*` mints never appear there
    /// and a post-fold read is a clean per-fold mint list.
    ///
    /// Growth is O(edit-log) — the same order [`original_placed`](Self::original_placed)
    /// already carries. NO pruning is added, and none may be added without a test: a
    /// redo-tail truncate does NOT truncate the edit-log and action ids are monotonic,
    /// so stale keys are UNREACHABLE rather than merely unlikely.
    live_minted: BTreeMap<u64, Vec<NodeId>>,
    /// The docks each `Rotate` record SEVERED, keyed by that record's
    /// `(action, sequence)` — the NON-SERIALIZED undo-capture for CONNECT-03 /
    /// SEED-006, the fourth instance of the `removed_ports` (PORT-07) /
    /// `prior_configs` (CFG-02) / `DeletedSubgraph` (12-05) pattern.
    ///
    /// NEVER serialized (like `xlate` / `original_placed` / `removed_ports`), rebuilt
    /// PURELY by [`reconstruct_projection`](Self::reconstruct_projection)'s throwaway
    /// re-fold, which reads `fresh.last_tick.unlinked` JUST AFTER each tick-slice folds
    /// (the severance is a CONSEQUENCE of the fold, so the read is POST-fold — the one
    /// place this capture differs in shape from its two pre-fold siblings).
    /// `compute_inverse` looks the severed set up here to follow a `Rotate`'s inverse
    /// with N compensating `EditOp::Dock` records, so undo of a severing rotate survives
    /// save/load with ZERO serialized field. Deterministic `BTreeMap`.
    ///
    /// Growth is O(edit-log) and IN-MEMORY ONLY — the same order `removed_ports` and
    /// `live_minted` already carry, and it moves no fixture byte and no schema version.
    severed_docks: BTreeMap<(u64, u64), Vec<UnlinkedDock>>,
    /// The LIVE-AUTHORITATIVE twin of [`severed_docks`](Self::severed_docks): the docks
    /// each `Rotate` severed, harvested from the REAL `core.last_tick.unlinked` in
    /// [`capture_after_fold`](Self::capture_after_fold) at fold time, keyed by that
    /// record's `(action, sequence)`. NEVER serialized.
    ///
    /// Same rationale as [`live_minted`](Self::live_minted), which it sits beside rather
    /// than beside `live_removed_ports`: both are harvested from `last_tick` AFTER the
    /// certified fold, so both are correct BY CONSTRUCTION on the live core, while the
    /// throwaway re-fold's allocator runs behind the live one by exactly the number of
    /// nodes the edit log never minted. A session that never folds live keeps this map
    /// EMPTY, so its projection is
    /// byte-identical to the pre-CONNECT-03 behaviour.
    ///
    /// Attribution is by [`UnlinkedDock::node`], NEVER positional — see
    /// [`capture_after_fold`](Self::capture_after_fold)'s "Severed-dock attribution"
    /// docblock for why the mint harvest's `mint_idx` stepping cannot be copied here.
    ///
    /// Growth is O(edit-log) and IN-MEMORY ONLY, exactly as the siblings state.
    live_severed_docks: BTreeMap<(u64, u64), Vec<UnlinkedDock>>,
    /// The per-record severances of the batch about to fold, set by
    /// [`capture_before_fold`](Self::capture_before_fold) ONLY when the batch names one node
    /// in two or more severing records ([`severances_need_split`], phase 89) and consumed by
    /// the [`capture_after_fold`](Self::capture_after_fold) of the same batch. `None` for every
    /// other batch, which is attributed node-keyed exactly as before. NEVER serialized.
    live_severance_split: Option<Severances>,
    /// The running effective [`SourceTrigger`] per node on the LIVE fold path — the
    /// live mirror of `reconstruct_projection`'s `last_source_trigger`. A Source config
    /// is a CORE no-op (it never reaches `state`), so its prior value cannot be read
    /// from ANY core; it is tracked here across all `Configure{Source}` records (forward
    /// AND the inverse Configures an undo appends), updated AFTER each fold so the next
    /// capture sees this one's effect. Default [`SourceTrigger::Webhook`] when unset.
    /// NEVER serialized.
    live_last_source_trigger: BTreeMap<NodeId, SourceTrigger>,
    /// The effects emitted by every fold this session has driven SINCE THE LAST DRAIN
    /// ([`drain_effects`](Self::drain_effects)) — the WIRE-04 observation surface, added
    /// in plan 63-08.
    ///
    /// # Why a retained buffer and not a return value
    /// `Core::advance_edits` returns the `Vec<Command>` the tick emitted, and until this
    /// field every seam here except [`fold_live`](Self::fold_live) DROPPED it on the
    /// floor. A scenario test therefore could not assert that anything ever left the
    /// grid: no accessor existed and the value was already gone. The buffer is what makes
    /// an effect observable at all.
    ///
    /// # It ACCUMULATES across folds, and that is the load-bearing part
    /// [`advance`](Self::advance) loops one fold per tick, and a scenario calls
    /// `advance(SETTLE)` to run a whole settle budget in ONE call. A field holding only
    /// the LAST fold's effects would therefore report the final IDLE tick's, which are
    /// empty, and an effect emitted at tick N would be silently overwritten by every
    /// later tick. Appending is what keeps a reply emitted mid-settle observable after
    /// the settle.
    ///
    /// # NEVER serialized, so it moves no fixture byte (T-63-63)
    /// A sibling of `xlate` / `original_placed` / `live_minted`: in-memory only. Nothing
    /// `Scenario`/`to_fixture` writes reads it, nothing `snapshot(core)` digests reads it,
    /// and it is not part of `core` at all. Draining or not draining produces byte-identical
    /// fixtures and an identical `tick_hash`.
    ///
    /// # [`fold_live`](Self::fold_live) deliberately does NOT append here
    /// That seam RETURNS its commands to the live host, which consumes and dispatches
    /// them. Appending a second copy would double-book every dispatched effect and, since
    /// the host never drains, would grow without bound for as long as the app runs. The
    /// buffer exists for the seams that DISCARD, which is every other one.
    effects: Vec<Command>,
}

/// The direction [`GridSession::compute_inverse`] builds compensating records for:
/// [`Undo`](Direction::Undo) inverts the target action (marker `EditOp::Undo`);
/// [`Redo`](Direction::Redo) re-applies it (marker `EditOp::Redo`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Direction {
    /// Reverse the target action's effect (the inverse-per-op table, walked reverse).
    Undo,
    /// Re-apply the target action (the original ops, retargeted through `xlate`).
    Redo,
}

/// Wrap a frozen [`EditOp`] into an UNSTAMPED [`EditRecord`] — all four provenance
/// fields (`partition`/`sequence`/`tick`/`action`) `0`, `schema_version =
/// EDIT_SCHEMA_VERSION`. The live host stamps the four provenance fields before
/// folding via [`GridSession::fold_live`]; the shared shape used by both
/// [`GridSession::resolve_undo`] and [`GridSession::resolve_redo`].
fn unstamped_record(op: EditOp) -> EditRecord {
    EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: 0,
        tick: 0,
        action: 0,
        op,
    }
}

impl GridSession {
    /// A fresh session at genesis: an empty grid seeded with `seed`, an empty
    /// edit-log + view, and counters at 0.
    #[must_use]
    pub fn new(seed: u64) -> Self {
        Self {
            core: Core::genesis(LogHeader {
                schema_version: SCHEMA_VERSION,
                seed,
            }),
            edit_log: Vec::new(),
            event_log: Vec::new(),
            view: GridView::new(),
            sequence: 0,
            event_sequence: 0,
            action: 0,
            seed,
            undoable: Vec::new(),
            cursor: 0,
            undo_floor: 0,
            undo_floor_breach: false,
            label_connect_forged: false,
            xlate: BTreeMap::new(),
            original_placed: BTreeMap::new(),
            removed_ports: BTreeMap::new(),
            prior_configs: BTreeMap::new(),
            live_removed_ports: BTreeMap::new(),
            added_port_boxes: BTreeMap::new(),
            live_added_port_boxes: BTreeMap::new(),
            live_prior_configs: BTreeMap::new(),
            live_minted: BTreeMap::new(),
            severed_docks: BTreeMap::new(),
            live_severed_docks: BTreeMap::new(),
            live_severance_split: None,
            live_last_source_trigger: BTreeMap::new(),
            effects: Vec::new(),
        }
    }

    /// Apply one [`GridCommand`]: validate it against the view, and — on accept —
    /// stamp, log, and fold the RESOLVED record, returning a reference to the logged
    /// record. On reject returns the typed [`CommandError`] having produced NOTHING:
    /// the core, the edit-log, and the view are all byte-identical to before the
    /// attempt (SC#2).
    ///
    /// # A group returns its LAST record
    /// A command that logs a group returns the group's last record, not its first. Since
    /// phase 89 (D-08) a turn that docks logs `[Rotate, Dock, ...]` and returns the last
    /// `Dock`, so a caller that wants the turn's frozen `new_rot` reads it off
    /// [`edit_log`](Self::edit_log), never off this return (review IN-A-02).
    ///
    /// # Errors
    /// The typed [`CommandError`] from [`validate_normalize`] (the command changed
    /// nothing).
    pub fn apply(&mut self, cmd: GridCommand) -> Result<&EditRecord, CommandError> {
        // (0) Route the two transient undo/redo commands BEFORE the validate path:
        //     they are NEVER validated/normalized/stored as themselves (Q4.2, ELOG-02)
        //     — `undo()`/`redo()` append the frozen compensating records (a lineage
        //     marker + retargeted inverses) directly, and we hand back the LAST
        //     appended record (the inverse group's final record) as the apply result.
        match cmd {
            GridCommand::Undo => {
                self.undo()?;
                return Ok(self.edit_log.last().expect("undo appended its marker group"));
            }
            GridCommand::Redo => {
                self.redo()?;
                return Ok(self.edit_log.last().expect("redo appended its marker group"));
            }
            _ => {}
        }

        // (1) Validate against the read-only view paired with the core (occupancy +
        //     cells read from `core.state` — the single SPAT-01 authority), producing
        //     the RESOLVED record. A reject returns here having mutated nothing (SC#2).
        //     The transient lens borrows `view` + `core` immutably and is dropped
        //     before the mutable fold below.
        let mut group = validate_normalize(&self.view.lookup(&self.core), cmd)?;

        // (1b) 12-05: enrich a resolved Delete with the REAL removed subgraph, read from
        //      the LIVE pre-fold core (the subgraph is present only NOW). fold_delete
        //      ignores `captured`, so this is behaviour-neutral (corpus untouched).
        //      Per RECORD, so a paired delete captures BOTH legs' subgraphs (72-08).
        for record in &mut group {
            self.enrich_delete_capture(record);
        }

        // Tick-stamping discipline (W3): stamp at the session tick (== core.tick)
        // and assign the next monotonic sequence + action id, so the fold applies
        // the record at exactly its stamped tick and replay regroups identically.
        //
        // ONE action id across the WHOLE group and a FRESH sequence per record (72-08):
        // that is what makes a paired draw or a paired delete a single undo step, and it
        // is the same shape `set_belt_run_pace` and `enqueue_action_group` already use.
        // `self.action` advances ONCE, after the group, for the same reason.
        let action = self.action;
        for record in &mut group {
            record.tick = self.core.tick;
            record.sequence = self.sequence;
            record.action = action;
            record.partition = 0;
            self.sequence += 1;
        }
        self.action += 1;

        // (2) Append to the edit-log (the source of truth), then (3) fold it via the
        //     ONLY mutator: advance_edits applies the records at core.tick, then
        //     advances to tick+1 (CMD-05). The fold writes each Place's cell into
        //     core `GridState` (09-02). (4) Re-project the view's handle/kind/link
        //     tables from the fold (cells/occupancy now live in core — SPAT-01).
        //
        //     The WHOLE group folds in ONE `advance_edits` call, so a paired draw's two
        //     wires land on ONE tick rather than two. For the one-record group every
        //     other command produces this is byte-identical to the pre-72-08 single-record
        //     fold.
        let first = self.edit_log.len();
        self.edit_log.extend(group);
        let just_pushed: Vec<EditRecord> = self.edit_log[first..].to_vec();
        // LIVE capture, strictly BEFORE the fold: read these records' undo captures off
        // the REAL core (the only core where their `NodeId`s are guaranteed resolvable).
        self.capture_before_fold(&just_pushed);
        let cmds = self.core.advance_edits(&self.edit_log[first..], &[]);
        self.retain_effects(cmds);
        // LIVE capture, strictly AFTER the fold: harvest the ids these records minted from
        // the REAL allocator (the throwaway re-fold's allocator can run behind it).
        self.capture_after_fold(&just_pushed);
        self.view.apply_tick(&self.core);

        // Keep the undo/redo projection current. It is a STRICT optimization: the
        // authority is always the fold, so we recompute it as a pure re-fold of the
        // log (always byte-equal to a fresh reconstruction, hence to `replay`'s).
        self.reconstruct_projection();

        Ok(self.edit_log.last().expect("just pushed the record"))
    }

    /// Seal the history (plan 85-06, D-10, DEMO-05): append ONE
    /// [`EditOp::SealHistory`] record and fold it, so everything logged so far sits below
    /// the UNDO FLOOR ([`undo_floor`](Self::undo_floor)) and Undo answers
    /// [`NothingToUndo`](CommandError::NothingToUndo) at it.
    ///
    /// The record is stamped exactly as [`apply`](Self::apply) stamps one (a fresh
    /// sequence and a fresh action id, the session tick, partition 0) and folds in ONE
    /// tick, so a headless applier that seals advances the same ticks the host does when
    /// `seed_scene` seals (the two-applier regenerability tests rely on it). The fold
    /// changes no core state (the core's NOOP arm); the projection reads the record as
    /// "the floor is the cursor here".
    ///
    /// The host writes its seal through `Host::seal_history` in `seed_scene`, the one
    /// place a scene's history is sealed; this is the headless twin for appliers and
    /// tests.
    ///
    /// # Errors
    /// None today: a seal is always accepted, on any board. The `Result` keeps the
    /// signature in the family of the session's other log writers.
    pub fn seal_history(&mut self) -> Result<(), CommandError> {
        let record = EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: self.sequence,
            tick: self.core.tick,
            action: self.action,
            op: EditOp::SealHistory,
        };
        self.sequence += 1;
        self.action += 1;
        let first = self.edit_log.len();
        self.edit_log.push(record);
        let just_pushed: Vec<EditRecord> = self.edit_log[first..].to_vec();
        self.capture_before_fold(&just_pushed);
        let cmds = self.core.advance_edits(&self.edit_log[first..], &[]);
        self.retain_effects(cmds);
        self.capture_after_fold(&just_pushed);
        self.view.apply_tick(&self.core);
        self.reconstruct_projection();
        Ok(())
    }

    /// Record the LIVE-AUTHORITATIVE per-action undo captures for `records`, read from
    /// the REAL `self.core` STRICTLY BEFORE those records fold — the pre-fold half of
    /// the live capture pair (the post-fold half is
    /// [`capture_after_fold`](Self::capture_after_fold)).
    ///
    /// Called from ALL FOUR fold seams ([`apply`](Self::apply),
    /// [`apply_under_action`](Self::apply_under_action),
    /// [`append_inverse_group`](Self::append_inverse_group) and
    /// [`fold_live`](Self::fold_live)) immediately before their `advance_edits`, so
    /// every record a LIVE session folds is captured against the core it actually
    /// mutates. The pure-load paths ([`replay`](Self::replay) /
    /// [`replay_two_logs`](Self::replay_two_logs)) never call it, which is exactly why
    /// they stay byte-identical to the pre-fix behaviour.
    ///
    /// `RemovePort`: the target [`Port`] must be read while it is still live, so this
    /// runs BEFORE the fold. The index is applied with a BOUNDS-SAFE `get` — a forged
    /// out-of-range index yields `None` and skips, never panics (threat T-36-06,
    /// preserved verbatim in shape from the re-fold capture).
    ///
    /// `Configure`: the PRIOR effective config ([`prior_config_of`]); `Source` alone reads
    /// the running [`live_last_source_trigger`](Self::live_last_source_trigger) map
    /// because a Source config is a core no-op with no state to read. A wrong-kind or
    /// absent node is SKIPPED (threat T-39-FOLD-PANIC, panic-free on a forged log).
    ///
    /// Every capture goes through [`capture_slice`], the one helper the re-fold in
    /// `reconstruct_projection` calls too (plan 74.1-23). `records` is one fold batch, and
    /// a `fold_live` batch can name one node in several port edits; the helper then
    /// captures record by record instead of reading the pre-batch core for all of them.
    fn capture_before_fold(&mut self, records: &[EditRecord]) {
        // Phase 89: a batch naming one node in two severing records (a paused turn away and
        // back) is attributed record by record, read here off the PRE-fold core and handed to
        // the matching `capture_after_fold` (see `attribute_severances`).
        self.live_severance_split =
            severances_need_split(records).then(|| split_severances(&self.core, records));
        let captured = capture_slice(&self.core, records, &self.live_last_source_trigger);
        for (key, boxed) in captured.added_port_boxes {
            self.live_added_port_boxes.insert(key, boxed);
        }
        for (key, removed) in captured.removed_ports {
            self.live_removed_ports.insert(key, removed);
        }
        for (key, prior) in captured.prior_configs {
            self.live_prior_configs.insert(key, prior);
        }
    }

    /// Record the LIVE-AUTHORITATIVE post-fold captures for `records` — the post-fold
    /// half of the pair (see [`capture_before_fold`](Self::capture_before_fold)).
    /// Called from the SAME four fold seams, strictly AFTER their `advance_edits` and
    /// before `reconstruct_projection` (which reads the maps).
    ///
    /// # Minted-id attribution
    /// `core.last_tick.placed` is reset at the top of every fold and pushed into by
    /// THREE folds — `fold_place`, `fold_draw_belt` and (63-02) `fold_draw_wire` — so
    /// after the fold it holds exactly the ids this batch minted, in MINT ORDER —
    /// which equals RECORD ORDER. So walking `records` and stepping one slot per
    /// minting op (`Place` / `DrawBelt` / `DrawWire`) attributes each id to its action.
    /// That is the very invariant `compute_inverse`'s `minting_ops != minted.len()`
    /// parity check already leans on: a minting op that folds to a NO-OP (a forged
    /// log's unknown `Place` kind) pushes nothing, so this harvest comes up SHORT
    /// exactly as the re-fold harvest does, and the parity reject still fires as a
    /// typed `UndoDoesNotFit` instead of an OOB panic (CR-01).
    ///
    /// # Severed-dock attribution (CONNECT-03 / SEED-006) is BY NODE, never positional
    /// `core.last_tick.unlinked` is reset with the rest of `last_tick` at the top of
    /// every tick (`tick.rs:79`) and pushed into by `fold_rotate` and `fold_remove_port`,
    /// so after the fold it holds exactly this batch's severances. It CANNOT be walked
    /// with the `mint_idx` stepping above: `placed` is exactly ONE
    /// id per minting op, while a `Rotate` emits a VARIABLE number of `UnlinkedDock`s —
    /// zero, one, or several (`rotate_footprint`'s Landmine 1 records that a belt docked
    /// Head AND Tail to the same rotating node gets TWO independent verdicts). Positional
    /// stepping cannot split a variable-length list across records.
    ///
    /// So each severing record claims the subset of `last_tick.unlinked`
    /// where `u.node == *node`. That is EXACT unless two severing records in ONE batch
    /// name the SAME node. A `GridSession::apply` log never produces such a batch, but the
    /// host's `fold_live` does: a paused R then Shift+R folds two `Rotate`s of one machine
    /// in one drain pass (phase 89 measured the old A3 `debug_assert!` firing there). Such a
    /// batch is split record by record against the pre-fold core in
    /// [`capture_before_fold`](Self::capture_before_fold), and `attribute_severances`
    /// checks that every severance is attributed exactly once either way.
    ///
    /// # THIRD hand-maintained correspondence (67-03): which ops write `last_tick.unlinked`
    /// The matcher below now leans on a THIRD hand-maintained, compiler-unchecked list,
    /// beside the two named in the next section: the set of folds that push into
    /// `core.last_tick.unlinked`.
    ///
    /// THAT SET GREW TO TWO IN 73-06 (UNDO-05) and this note is the record of it. It was
    /// `{ Rotate }` from 67-03 until phase 73; it is now `{ Rotate, RemovePort }`, because
    /// removing a port releases the dock that was ON it. Both writers go through the ONE
    /// `GridState::judge_docks` machinery with their own verdict passed in, so a third
    /// writer (phase 76's SHAPE-06) will arrive the same way and must arrive HERE too.
    ///
    /// CITE THE FUNCTIONS, NOT THE LINES. The wording this replaces pinned a line range in
    /// `tick.rs`, twice, and both had rotted so far that the range named no write at all -
    /// so the correspondence they were meant to hold was unverifiable at exactly the
    /// moment it mattered. The durable form is the grep, which cannot rot:
    /// `grep -n 'core.last_tick.unlinked' crates/fabrico-core/src/tick.rs` returns exactly
    /// TWO writes, one in `fn fold_remove_port` and one in `fn fold_rotate`. If it ever
    /// returns more, this note is out of date and so is the matcher below it. Measured at
    /// 73-06 as `tick.rs:769` and `tick.rs:835`; those two numbers are dated on purpose and
    /// the function names are what to trust.
    ///
    /// The MOMENT a THIRD fold starts
    /// pushing there, this arm's matcher must grow to name it and
    /// `compute_inverse`'s Undo side must grow a compensating arm for it, or that op's
    /// severances are captured under no key at all and its undo silently strands a belt
    /// — the exact pre-Phase-67 defect, re-introduced for one op instead of all of them.
    /// Change both, or change neither.
    ///
    /// # The matcher below and `compute_inverse`'s parity filter are ONE list in two
    /// places (T-63-50)
    /// Both are hand-maintained and neither is compiler-checked, and they must always
    /// name the SAME set of ops. Updating only the parity filter leaves this walk
    /// skipping `DrawWire`, so a multi-record tick of `[DrawWire, Place]` steps
    /// `mint_idx` only for the `Place` and hands `placed[0]` — the WIRE — to the
    /// `Place`'s action. That was MEASURED on a tree carrying only the parity fix,
    /// both with the two records under one action and under two: in every shape it
    /// surfaced as a typed `UndoDoesNotFit` (`Malformed` then), because a short harvest breaks the very parity
    /// it was meant to satisfy, and where parity does hold the `inverse_target_matches`
    /// kind clause refuses the `Delete` of a wire named with a machine's kind. So the
    /// mis-attribution is CONTAINED by two independent guards rather than silent —
    /// which is the reason to keep both of those guards, not a reason to leave this
    /// list half-updated. Change both, or change neither.
    ///
    /// Ids are APPENDED (never overwritten) per action, so a multi-tick action — a move,
    /// which folds two records under one shared action across two ticks — accumulates
    /// across its ticks exactly the way `reconstruct_projection`'s `group_placed` does.
    ///
    /// It also advances the running live Source-trigger map, mirroring the re-fold's
    /// post-slice update so an inverse `Configure{Source}` is tracked too.
    fn capture_after_fold(&mut self, records: &[EditRecord]) {
        let placed = self.core.last_tick.placed.clone();
        let mut mint_idx = 0usize;
        for r in records {
            if matches!(
                r.op,
                EditOp::Place { .. } | EditOp::DrawBelt { .. } | EditOp::DrawWire { .. }
            ) {
                if let Some(&id) = placed.get(mint_idx) {
                    self.live_minted.entry(r.action).or_default().push(id);
                }
                mint_idx += 1;
            }
            if let EditOp::Configure {
                node,
                config: MachineConfig::Source { trigger },
                ..
            } = &r.op
            {
                self.live_last_source_trigger.insert(*node, trigger.clone());
            }
        }

        // CONNECT-03 / SEED-006: the severed-dock harvest, node-keyed. See the
        // "Severed-dock attribution" docblock above for why `mint_idx` stepping is not
        // reused here and why the node key is exact under research assumption A3.
        //
        // NOTE (67-03 task 1): this is the LIVE half only. Its reconstruct-time twin —
        // the `fresh.last_tick.unlinked` harvest inside `reconstruct_projection` — is
        // OWNED BY TASK 2 and lands in its own commit, because it is the one part of
        // CONNECT-03 that can ship broken behind a fully green live suite (it fails only
        // after a save and a load). Between those two commits this shape is incomplete
        // BY PLAN, not by omission.
        // ALWAYS record EVERY Rotate this session folds LIVE — an EMPTY vec included
        // (67-REVIEW CR-01), through the SAME `attribute_severances` the reconstruct-time
        // twin calls (67-REVIEW WR-04).
        //
        // # Absence in this map is a CLAIM, and it has to mean exactly one thing
        // `reconstruct_projection`'s live-wins merge replaces a whole ACTION's severed
        // set only `if !live_for_action.is_empty()`, and falls back to the throwaway
        // re-fold's harvest otherwise. That fallback is correct for exactly one reading
        // of absence — "this action was never folded live", the pure-load path. Under
        // the old `if !mine.is_empty()` guard, absence ALSO meant "folded live, severed
        // nothing", which is the overwhelmingly common case, and the merge could not
        // tell the two apart.
        //
        // That ambiguity was reachable and it corrupted real state. On a board whose core
        // held nodes the edit log never minted (the shipped demo of the time minted its
        // request pair outside the log) the throwaway `fresh` allocator runs behind the
        // live one, so a re-folded `Rotate` lands on a real-but-WRONG node and can INVENT
        // a severance the live fold never had. With no live entry to speak for the
        // action, that invention survived the merge into `severed_docks` and
        // `compute_inverse` folded it as an ordinary compensating `EditOp::Dock`, a link
        // written into LIVE state under the ordinary Undo button. A leg in
        // `rotate_undo_redock.rs` drove exactly that board and was RED before this loop
        // moved out of the guard; plan 85-09 removed that leg with the last shipped board
        // of that shape, and this loop stays the backstop for a hand-built core.
        //
        // Cost of always inserting: one map entry per Rotate record rather than one per
        // SEVERING Rotate. `compute_inverse` reads with `.get()` and iterates, so a
        // `Some(empty)` emits nothing — the happy path is byte-identical to the old one.
        let unlinked = self.core.last_tick.unlinked.clone();
        let split = self.live_severance_split.take();
        for (key, mine) in attribute_severances(records, &unlinked, split) {
            self.live_severed_docks.insert(key, mine);
        }
    }

    /// Enrich a freshly-resolved [`EditOp::Delete`] record with the REAL removed
    /// subgraph (12-05), captured from the LIVE pre-fold `core.state` — the deterministic
    /// cascade set (`docked_wire_belts`) + each belt's geometry + incident links the undo
    /// driver replays to restore the machine AND rewire it (RESEARCH Pitfall 2). A no-op
    /// for any non-Delete op. Behaviour-neutral: `fold_delete` never consumes `captured`.
    fn enrich_delete_capture(&self, record: &mut EditRecord) {
        if let EditOp::Delete { node, captured, .. } = &mut record.op {
            *captured = self.core.state.capture_deleted_subgraph(*node);
        }
    }

    /// Fold a batch of RUNTIME [`Event`]s at the current tick and append them to the
    /// session's SECOND log (the `event_log`), returning the just-stamped slice. This
    /// is the TEST-05 "run the factory" seam: `apply` mutates topology (the edit-log),
    /// `pump` injects runtime inputs (`ManualInject`, …) into the live grid.
    ///
    /// Each `pump` is ONE tick (exactly like `apply`): the incoming events are stamped
    /// `event.tick = core.tick`, assigned the next monotonic `event_sequence`, and set
    /// `partition = 0`, then folded EDITS-FIRST via `advance_edits(&[], events)` (no
    /// topology edits this tick), which applies them AT `core.tick` then advances to
    /// `tick + 1`. The view is re-projected and the stamped events appended to the log.
    ///
    /// # Tick-stamping discipline (W3 — the replay-equivalence contract; Pitfall 2)
    /// `pump` OVERWRITES the caller's tick/sequence/partition (the session owns
    /// ordering — a caller can NEVER forge a tick; threat T-13-01). This MUST mirror
    /// `apply`'s W3 stamp block exactly so that on replay `Core::run_log_two_logs`
    /// regroups these events by the IDENTICAL stamped tick and reproduces a
    /// byte-identical `Core` — proven by `replay_two_logs` in `tests/pump.rs`. Only the
    /// `payload` (and `schema_version`) survive verbatim from the caller.
    pub fn pump(&mut self, events: &[Event]) -> &[Event] {
        let start = self.event_log.len();
        // An empty pump is a NO-OP: fold nothing and advance NO tick. Otherwise the
        // bare `advance_edits(&[], &[])` below would advance an UNLOGGED idle tick that
        // `run_log_two_logs` cannot reproduce on replay, diverging the live session from
        // its `replay_two_logs` byte-image (WR-13-01). Deliberate idle ticks go through
        // `advance(n)`, which the determinism helper drives symmetrically on BOTH the
        // live and the replayed session.
        if events.is_empty() {
            return &self.event_log[start..];
        }
        let stamped: Vec<Event> = events
            .iter()
            .map(|e| {
                let stamped = Event {
                    schema_version: e.schema_version,
                    partition: 0,
                    sequence: self.event_sequence,
                    tick: self.core.tick,
                    payload: e.payload.clone(),
                };
                self.event_sequence += 1;
                stamped
            })
            .collect();
        // Fold EDITS-FIRST with no topology edits this tick: advance_edits applies the
        // events AT core.tick, then advances to tick + 1 (the ONLY Core mutator, CMD-05).
        let cmds = self.core.advance_edits(&[], &stamped);
        self.retain_effects(cmds);
        // Mirror run_log_two_logs' diagnostics discipline: count the events consumed
        // this tick into core.cursor. advance_edits (one bare tick) does NOT touch the
        // cursor, but the canonical REPLAY (run_log_two_logs) increments it by the event
        // count (core.rs:258) — so the live pump MUST too, or a pumped session and its
        // replay diverge on the serialized cursor (the W3 cursor-accounting half of the
        // replay-equality contract; proven by tests/pump.rs).
        self.core.cursor += stamped.len() as u64;
        self.view.apply_tick(&self.core);
        self.event_log.extend(stamped);
        &self.event_log[start..]
    }

    /// Advance `ticks` IDLE ticks: each tick folds `advance_edits(&[], &[])` (no edits,
    /// no events) and re-projects the view, so multi-tile belts/sim settle (a belt moves
    /// one slot every `ticks_per_slot` ticks — Pitfall 1, SLOT-03; this read "belts move
    /// 1 slot/tick", retired by `62-CONTEXT.md` D-01/D-02, and a caller sizing a settle
    /// count against that rate under-runs as SILENCE rather than as an error). Mutates
    /// NEITHER log — idle ticks carry no logged input,
    /// so a replay reaches them only by re-driving the same edits + events (the final
    /// settle tick must be covered by a logged record for `run_log_two_logs` to match;
    /// the harness advances both the live AND the replayed session by the same count).
    pub fn advance(&mut self, ticks: u64) {
        for _ in 0..ticks {
            let cmds = self.core.advance_edits(&[], &[]);
            self.retain_effects(cmds);
            self.view.apply_tick(&self.core);
        }
    }

    /// APPEND one fold's emitted effects to [`effects`](Self::effects) — the single line
    /// that makes an effect emitted mid-settle survive to the drain.
    ///
    /// It appends rather than assigns, and that was measured rather than assumed. Against
    /// an assigning version, `fabrico_scenario::scene::tests::drain_effects_accumulates_across_a_whole_settle`
    /// fails with `got []`: `advance(SETTLE)` folds one tick per iteration, the sink emits
    /// its effect early in the settle, and every later tick overwrites the buffer with the
    /// empty final idle tick. Do not "simplify" this to an assignment.
    fn retain_effects(&mut self, cmds: Vec<Command>) {
        self.effects.extend(cmds);
    }

    /// Take every effect emitted since the last drain and CLEAR the buffer — the WIRE-04
    /// observation seam a scenario test asserts through
    /// [`Scene::drain_effects`](../../fabrico_scenario/scene/struct.Scene.html).
    ///
    /// Draining is a read of NON-SERIALIZED in-memory state: it touches neither log,
    /// neither the core nor the view, so it moves no fixture byte and no `tick_hash`
    /// (T-63-63).
    pub fn drain_effects(&mut self) -> Vec<Command> {
        std::mem::take(&mut self.effects)
    }

    /// The append-only RUNTIME event-log (the SECOND ordered log `pump` owns) — the
    /// replay source `run_log_two_logs` folds alongside the [`edit_log`](Self::edit_log).
    #[must_use]
    pub fn event_log(&self) -> &[Event] {
        &self.event_log
    }

    /// Move a machine: apply a [`Delete`](GridCommand::Delete) of `node` followed by
    /// a [`Place`](GridCommand::Place) of `kind` at `(cell_x, cell_y)`, both stamped
    /// with ONE shared `action` id (the `action` counter does NOT increment between
    /// the pair). Move = delete + place under one action — the Phase-12 coalescing
    /// groundwork (UNDO-02), NOT a new `EditOp::Move` variant: the delete frees the
    /// old footprint AND cascade-detaches its docked belts (FOOT-04), the place
    /// re-claims the new footprint, and both records share the action id so a future
    /// undo step coalesces them.
    ///
    /// The Delete must fold BEFORE the Place is validated so the freed cells (incl.
    /// an overlapping move) are available to re-claim. On success the shared `action`
    /// is consumed once (the next [`apply`](Self::apply) gets the following id, so the
    /// monotonic action stream is preserved).
    ///
    /// # Errors
    /// The typed [`CommandError`] from the Delete or the Place validation. A Delete
    /// that rejects leaves the grid byte-identical (SC#2); a Place that rejects
    /// AFTER the Delete folded leaves the node deleted (the move degrades to a
    /// delete — Move is delete+place, not a transaction, for v2.0).
    pub fn move_machine(
        &mut self,
        node: u64,
        kind: u8,
        cell_x: i32,
        cell_y: i32,
    ) -> Result<(), CommandError> {
        // ONE shared action id for both records (no increment between the pair).
        let action = self.action;
        self.apply_under_action(GridCommand::Delete { node }, action)?;
        // The Delete has FOLDED — the shared action id is now SPENT, regardless of the
        // Place outcome (WR-01). Consume it BEFORE the Place leg so that a Place that
        // rejects after the Delete folded still advances `self.action`: otherwise the
        // orphaned Delete keeps `action = N` AND the next unrelated `apply()` would
        // re-stamp `action = N`, fusing two distinct logical actions into one undo step
        // (the `EditRecord.action` one-action-per-undo invariant Phase-12 coalesces on).
        // Both move records still SHARE this `action` (the Place below stamps the
        // captured `action`, not the incremented `self.action`).
        self.action += 1;
        self.apply_under_action(GridCommand::Place { kind, cell_x, cell_y }, action)?;
        Ok(())
    }

    /// Place a Router PRESET (ROUTE-06) — an HTTP Router (`Medium::Electrical`) or an
    /// Item Router (`Medium::Mechanical`) - as a `Node::Router` carrying one In,
    /// [`ROUTER_OUT_ARITY`] Outs and one Fault at
    /// `(cell_x, cell_y)`, seeded PURELY from existing serialized commands: one
    /// `Place{ROUTER}` plus the plan-02 `RemovePort`/`AddPort` sequence that strips the
    /// bare catalog ports and re-seeds the preset ports, the In and Outs AT `medium` and
    /// the Fault at `Medium::Mechanical` for both presets (plan 85-05, D-22; see
    /// [`router_preset_ports`]). The number of
    /// `RemovePort` legs is READ FROM [`port_catalog`], so widening the Router's arity
    /// (ROUTE-02) changes the record sequence automatically instead of silently leaving
    /// the surplus bare ports behind. The WHOLE sequence
    /// runs under ONE shared action id (via [`apply_under_action`](Self::apply_under_action)),
    /// so a preset placement is a SINGLE undo step.
    ///
    /// # ROUTE-06 zero-serialized-change (CONTEXT hard rule)
    /// This is the CONTEXT-directed preset mechanism: TWO palette presets over the ONE
    /// `Node::Router` engine, differing ONLY by `Port.medium`. `medium` is the SOLE
    /// parameter and the command sequence is IDENTICAL for both media — there is NO new
    /// `machine_kind` byte, NO new `Place`/catalog field, NO new serialized shape, and
    /// routing is NOT forked per medium (both fold to `add_router`/`Node::Router`).
    ///
    /// # Errors
    /// The typed [`CommandError`] from any leg (e.g. [`FootprintCollision`](CommandError::FootprintCollision)
    /// / [`OutOfBounds`](CommandError::OutOfBounds) at Place). A leg that rejects leaves
    /// the grid at whatever the prior legs folded (mirroring [`move_machine`](Self::move_machine)'s
    /// non-transactional composition); a Place that rejects up front leaves state
    /// byte-identical (SC#2).
    pub fn place_router_preset(
        &mut self,
        medium: Medium,
        cell_x: i32,
        cell_y: i32,
    ) -> Result<(), CommandError> {
        // ONE shared action id for the whole preset (Place + the port-seeding legs), so
        // the preset is a single undoable step. `self.action` is advanced ONCE at the end.
        let action = self.action;
        // (1) Place the bare ONE Node::Router engine (catalog ports: In + Out, Mechanical).
        self.apply_under_action(
            GridCommand::Place { kind: machine_kind::ROUTER, cell_x, cell_y },
            action,
        )?;
        // Resolve the freshly minted router's dense handle (the AddPort/RemovePort
        // commands address it by handle).
        let id = *self
            .core
            .last_tick
            .placed
            .last()
            .expect("Place minted the router this tick");
        let node = self.view.handle_of(id).expect("the minted router has a handle");
        // (2) Symmetric retype/extend to the preset profile AT `medium`: strip EVERY bare
        //     catalog port (highest index FIRST so index 0 stays valid), then seed the
        //     preset fresh. The SEQUENCE SHAPE is IDENTICAL for both media — `medium` is
        //     the only value that changes — so an Item and an HTTP Router share one code
        //     path (zero-serialized-change; routing never forks per medium).
        // BOTH halves of this symmetric operation are DERIVED, never written down, so
        // they read as ONE rule rather than two.
        //
        // The strip count comes from the catalog (T-63-59). Before 63-07 this was two
        // literal `RemovePort`s, which was correct only while the Router catalog
        // happened to declare two ports; ROUTE-02 widened it, and a hard-coded 2 would
        // have left the appended bare MECHANICAL Outs on an HTTP Router, where a wire
        // drawn from one is a MediumMismatch the user cannot explain from what the
        // palette said it placed.
        let bare_ports = port_catalog(machine_kind::ROUTER).1.len();
        for index in (0..bare_ports).rev() {
            // Highest index FIRST, so every lower index stays valid as the list shrinks.
            let index = u16::try_from(index).unwrap_or(u16::MAX);
            self.apply_under_action(GridCommand::RemovePort { node, index }, action)?;
        }
        // The SEED count comes from `router_preset_ports`, the single producer the
        // palette view already reads (ROUTE-02, plan 65-05). Until then this half was
        // three literal `AddPort` calls that did not call the producer at all, so a
        // palette Router carried two Outs while the catalog said three and a two-rule
        // table had nowhere to send its second branch. One producer, one consumer: an
        // arity change now moves the palette listing and the placed machine together or
        // neither.
        for p in router_preset_ports(medium) {
            self.apply_under_action(
                GridCommand::AddPort {
                    node,
                    role: catalog_role_u8(p.role),
                    side: catalog_side_u8(p.side),
                    medium: catalog_medium_u8(p.medium),
                },
                action,
            )?;
        }
        // (3) 73-06: THE PRESET DECLARES ITS OWN DEFAULT, and it must, because step (2)
        //     just deleted the port the minted one named.
        //
        // A bare Router is minted `add_router(Vec::new(), Some(0))` - a `default` naming
        // its CATALOG Out, routing key 0. Step (2) then strips that very Out. Before 73-06
        // the fold left `default` untouched, so `Some(0)` silently survived the deletion of
        // the port it named and came to mean "the first PRESET Out" - a different physical
        // output from the one the value was written about. That is precisely the
        // silent-renumber defect UNDO-04 exists to close, and `fold_remove_port` now closes
        // it by clearing a `default` that names the removed key (ruling R-25).
        //
        // Which leaves this function owing a value it was previously inheriting by
        // accident. Without this leg a palette Router would arrive with `default: None`,
        // so an unmatched item would FAULT instead of leaving on output 1, and a Router
        // restored by undoing a Delete (which re-mints through `Place` and keeps `Some(0)`)
        // would behave differently from an identical-looking one placed from the palette.
        // Decided 2026-09-05: a preset that inherits a fallback from a port it
        // then deletes is itself the defect, and declaring it is honest while preserving
        // the shipped behaviour.
        //
        // `Some(0)` is the SAME observable answer as before, now said out loud: routing key
        // 0 is the first Out `router_preset_ports` just seeded. The table is empty because
        // a freshly placed Router has no rules, which is what
        // `frontend/e2e-live/24-one-board-all-six.spec.ts` reads back.
        //
        // Its twin is `seedRouterPreset` in `frontend/src/input/gestures.ts`, which is the
        // path the SHIPPED app takes (this function is reachable from tests and
        // `fabrico-scenario` only - see the note on `set_belt_run_pace`). BOTH had to grow
        // this leg or the two seams would disagree about what a Router is.
        self.apply_under_action(
            GridCommand::Configure {
                node,
                config: fabrico_protocol::MachineConfig::Router {
                    routes: Vec::new(),
                    default: Some(0),
                },
            },
            action,
        )?;
        // Consume the shared action id ONCE — the next unrelated apply gets the following
        // id, so the whole preset coalesces into exactly one undo group.
        self.action += 1;
        Ok(())
    }

    /// Set the same `ticks_per_slot` on EVERY belt in a run, under ONE shared action id,
    /// so a single `Undo` restores all of them (BELT-02, `D-68-07`). The third caller of
    /// [`apply_under_action`](Self::apply_under_action), following
    /// [`place_router_preset`](Self::place_router_preset)'s shape exactly: capture
    /// `self.action` once, emit one `Configure` per belt under that captured id, advance
    /// `self.action` exactly once.
    ///
    /// # THIS IS NOT THE PATH THE SHIPPED APP TAKES, and its green says nothing about it
    /// `D-68-16` corrected exactly this, and it is the single most misleading thing about
    /// this seam. This helper and its two siblings ([`move_machine`](Self::move_machine),
    /// [`place_router_preset`](Self::place_router_preset)) are reachable from TESTS and
    /// from `fabrico-scenario`'s scene builder ONLY. No `fabrico-host` and no
    /// `fabrico-app` code path calls any of them; the running app goes
    /// `input_apply::apply_gesture_frame` -> `Host::enqueue_action_group`
    /// (`driver.rs:380-390`), which is the LIVE equivalent and is asserted separately in
    /// `crates/fabrico-host/tests/belt_run_pace.rs`. A reader who takes THIS function's
    /// green as evidence about the shipped app is making precisely the mistake
    /// `68-UI-SPEC.md`'s BLOCKING FINDING 2 describes. The two seams are independent and
    /// each needs its own proof.
    ///
    /// It exists because `fabrico-command` is where saves, replays and the scenario
    /// builder live, and the one-undo-step property has to hold there too - including
    /// across a save and a reload, which is what
    /// `set_belt_run_pace_survives_a_save_and_one_undo_on_the_reloaded_session` pins.
    ///
    /// # It can HALF-APPLY, and the live seam deliberately cannot
    /// Legs run in order and a rejected leg returns immediately, so the belts before it
    /// keep the new pace - the [`move_machine`](Self::move_machine) shape, not a
    /// transaction. The LIVE seam validates every record before enqueuing any (68-02),
    /// which is a stronger contract; this one is not upgraded to match because
    /// `apply_under_action` folds as it goes and there is no headless caller that needs
    /// the stronger property. The half-applied prefix is still ONE undo step, because
    /// every record it wrote carries the captured id.
    ///
    /// # Cost, MEASURED and not assumed (plan 68-04)
    /// [`apply_under_action`](Self::apply_under_action) calls `reconstruct_projection`
    /// on EVERY call and that function's own docblock calls it O(history) work, so a run
    /// of N pays it N times and this helper is O(N x history).
    /// `belt_run_pace_projection_cost_at_the_upper_end` is the runnable measurement and
    /// these are the figures it printed, on a 456-record log:
    ///
    /// | belts | release | debug | per belt (release) |
    /// |-------|---------|-------|--------------------|
    /// | 1     | 0.15 ms | 1.2 ms | 152 us |
    /// | 32    | 4.9 ms  | 39 ms  | 153 us |
    /// | 256   | 42 ms   | 346 ms | 163 us |
    ///
    /// The per-belt cost is FLAT at a fixed history, so N is linear and the history term
    /// is what sets the constant. **NO RUN-LENGTH BOUND IS ADDED HERE**, and the reason
    /// is not that 42 ms is small - it is not, it is two and a half frames. It is that
    /// this helper is not on any frame budget at all: it is reachable from tests and the
    /// scenario builder ONLY (see above), where the cost is a one-off authoring cost and
    /// not a per-tick one. A bound here would also have to restate
    /// `fabrico_host::sim_loop::MAX_RUN_PACE_BELTS` as a second number in a crate that
    /// cannot see it, which is a worse defect than the cost it would guard.
    ///
    /// The LIVE path does not have this problem at all: `Host::enqueue_action_group`
    /// ENQUEUES and the tick folds ONCE, so it pays `reconstruct_projection` a single
    /// time for the whole run regardless of N. That is a second independent reason
    /// `D-68-16` prefers it, on top of the reachability one.
    ///
    /// # Errors
    /// [`CommandError::Malformed`] for an EMPTY belt list - the same tag and the same
    /// reason as the live arm's empty-run refusal: answering `Ok` to a gesture that did
    /// nothing is worse than a typed refusal. Otherwise the typed error from the first
    /// leg that rejects, most reachably [`CommandError::UnknownNode`] for a stale handle
    /// or [`CommandError::PaceOutOfRange`] for a pace outside [`BELT_PACE_RANGE`].
    pub fn set_belt_run_pace(
        &mut self,
        belts: &[u64],
        ticks_per_slot: u32,
    ) -> Result<(), CommandError> {
        // Refuse BEFORE capturing an id, so an empty run burns nothing - the same
        // ordering the live arm uses, and for the same reason.
        if belts.is_empty() {
            return Err(CommandError::Malformed);
        }
        // ONE shared action id for the whole run, so N belts are ONE undo step.
        let action = self.action;
        for &node in belts {
            if let Err(e) = self.apply_under_action(
                GridCommand::Configure {
                    node,
                    config: fabrico_protocol::MachineConfig::Belt { ticks_per_slot },
                },
                action,
            ) {
                // CONSUME THE SHARED ID EVEN THOUGH THIS LEG REJECTED. `move_machine`
                // carries the same warning verbatim in substance and it is the whole
                // reason this is not a plain `?`: any earlier leg has already FOLDED and
                // keeps `action = N`, so if `self.action` stayed at N the next unrelated
                // `apply()` would re-stamp N and FUSE two distinct logical actions into
                // one undo step - the `EditRecord.action` one-action-per-undo invariant
                // Phase-12 coalesces on. Advancing here costs at most one skipped id in
                // the case where the FIRST leg rejected and nothing folded, which is
                // invisible (the undoable stack is derived from the records that exist,
                // never from the counter). `a_refused_belt_run_still_advances_the_action_id`
                // is what proves it, and it asserts the NEXT action's id - asserting only
                // that the run returned an error cannot see the fusion at all.
                self.action += 1;
                return Err(e);
            }
        }
        // Consume the shared id ONCE: the next unrelated apply gets the following id,
        // so the whole run coalesces into exactly one undo group.
        self.action += 1;
        Ok(())
    }

    /// Undo the last still-live action group (UNDO-01/02): append a marker-first,
    /// FROZEN, retargeted inverse group under ONE new shared action, folded in ONE
    /// tick — strictly append-only (the edit-log only ever grows, never mutates).
    ///
    /// On an empty undo stack (`!can_undo()`) returns [`CommandError::NothingToUndo`]
    /// having produced NOTHING: no record, no fold, core/edit-log/view byte-identical
    /// (T-12-06, SC#2 — never a panic / cursor underflow).
    ///
    /// # Errors
    /// [`NothingToUndo`](CommandError::NothingToUndo) on an empty stack;
    /// [`UndoDoesNotFit`](CommandError::UndoDoesNotFit) if the target group is structurally
    /// inconsistent — its minting-op count disagrees with the ids it actually minted,
    /// reachable only via a forged/corrupted log loaded through `replay` (CR-01). In
    /// BOTH cases nothing is appended (the inverse is computed BEFORE any mutation), so
    /// a reject leaves core/edit-log/view byte-identical.
    fn undo(&mut self) -> Result<(), CommandError> {
        let target = self.undo_target().ok_or(CommandError::NothingToUndo)?;
        // Compute the FROZEN inverse ONCE, BEFORE any mutation (Q2.1 — never
        // re-derived at fold time). A reject here leaves state byte-identical.
        let inverse = self.compute_inverse(target, Direction::Undo)?;
        self.append_inverse_group(inverse);
        Ok(())
    }

    /// Redo the next undone action group (UNDO-01): the mirror of [`undo`](Self::undo)
    /// — append a `Redo` marker + the re-applied original records (endpoints
    /// retargeted through [`xlate`] AFTER any prerequisite re-mints in the same group
    /// fold, Pitfall 1), under ONE shared action, folded in ONE tick. Append-only.
    ///
    /// # Errors
    /// [`NothingToRedo`](CommandError::NothingToRedo) on a full cursor (state
    /// byte-identical); [`UndoDoesNotFit`](CommandError::UndoDoesNotFit) per `compute_inverse`
    /// (a structurally-inconsistent target group from a forged/corrupted log) — in both
    /// cases nothing is appended, so a reject leaves state byte-identical.
    fn redo(&mut self) -> Result<(), CommandError> {
        let target = self.redo_target().ok_or(CommandError::NothingToRedo)?;
        let group = self.compute_inverse(target, Direction::Redo)?;
        self.append_inverse_group(group);
        Ok(())
    }

    /// Compute the FROZEN, UNSTAMPED inverse group for the top undoable action — the
    /// read-only ("resolve") half of the private [`undo`](Self::undo), SPLIT so the
    /// LIVE host can stamp provenance and fold at its own tick boundary (Plan 19,
    /// decision (c) Option B). This is exactly `undo()` MINUS the
    /// [`append_inverse_group`](Self::append_inverse_group) call: it reuses
    /// [`compute_inverse`](Self::compute_inverse) VERBATIM (already `&self`, frozen,
    /// xlate-retargeted, CR-01 parity-guarded) and mutates NOTHING — call it twice and
    /// get the identical result; `can_undo()` / the cursor are unchanged.
    ///
    /// Every returned [`EditRecord`] carries PLACEHOLDER provenance
    /// (`partition`/`sequence`/`tick`/`action` all `0`, `schema_version =
    /// EDIT_SCHEMA_VERSION`) — the host stamps all four before folding via
    /// [`fold_live`](Self::fold_live).
    ///
    /// # Errors
    /// [`NothingToUndo`](CommandError::NothingToUndo) on an empty undo stack (never a
    /// panic / cursor underflow — `undo_target` uses `checked_sub`);
    /// [`UndoDoesNotFit`](CommandError::UndoDoesNotFit) from `compute_inverse` on a
    /// forged/corrupted log (CR-01), never a panic. In both cases nothing is produced
    /// and self is untouched.
    pub fn resolve_undo(&self) -> Result<Vec<EditRecord>, CommandError> {
        let target = self.undo_target().ok_or(CommandError::NothingToUndo)?;
        let ops = self.compute_inverse(target, Direction::Undo)?;
        Ok(ops.into_iter().map(unstamped_record).collect())
    }

    /// Compute the FROZEN, UNSTAMPED re-apply group for the next redoable action — the
    /// mirror of [`resolve_undo`](Self::resolve_undo) using
    /// [`redo_target`](Self::redo_target) / [`Direction::Redo`]. The read-only half of
    /// the private [`redo`](Self::redo); reuses `compute_inverse` VERBATIM, mutates
    /// nothing, and returns UNSTAMPED records (all four provenance fields `0`) for the
    /// host to stamp before [`fold_live`](Self::fold_live).
    ///
    /// # Errors
    /// [`NothingToRedo`](CommandError::NothingToRedo) on a full cursor (never a panic —
    /// `redo_target` uses `.get()`); [`UndoDoesNotFit`](CommandError::UndoDoesNotFit) from
    /// `compute_inverse` on a forged/corrupted log (CR-01). In both cases nothing is
    /// produced and self is untouched.
    pub fn resolve_redo(&self) -> Result<Vec<EditRecord>, CommandError> {
        let target = self.redo_target().ok_or(CommandError::NothingToRedo)?;
        let ops = self.compute_inverse(target, Direction::Redo)?;
        Ok(ops.into_iter().map(unstamped_record).collect())
    }

    /// Compute the FROZEN, retargeted compensating records for action `target` in the
    /// given [`Direction`] — the lineage marker FIRST, then the per-record inverses
    /// (UNDO) or re-applications (REDO), every endpoint resolved to the CURRENT live
    /// id through [`xlate`] (Pattern 2 + Pitfall 1). Computed ONCE at issue time and
    /// returned by value so the caller folds it VERBATIM (never re-derived).
    ///
    /// UNDO walks the target group's records in REVERSE (the last-applied leg is
    /// undone first — e.g. a move's `Place` leg inverts to a `Delete` BEFORE its
    /// `Delete` leg inverts to a re-`Place`, so the new footprint frees before the old
    /// one re-claims). REDO walks them FORWARD (re-applying the original sequence).
    ///
    /// # Errors
    /// [`UndoDoesNotFit`](CommandError::UndoDoesNotFit) when the target group is structurally
    /// inconsistent: its minting-op count (Place/Wire/DrawBelt) disagrees with
    /// `minted.len()` (the ids the action actually minted). A self-produced log mints
    /// exactly one node per minting op, so this is UNREACHABLE for any log a
    /// `GridSession` built — it fires only on a forged/corrupted log supplied through
    /// the pub `replay` primitive, where a minting op that folds to a no-op (an unknown
    /// `Place` kind, a dead-endpoint `Wire`) would otherwise drive the reverse Undo
    /// walk's `mint_idx` into an underflow/OOB panic (CR-01). Computed BEFORE any
    /// mutation, so a reject leaves state byte-identical. The full 12-05 subgraph
    /// restore (re-`Place` + re-`Wire`/`DrawBelt`+`Dock`) is itself infallible.
    ///
    /// Also [`UndoDoesNotFit`](CommandError::UndoDoesNotFit) when either walk detects that the
    /// projection has lost id alignment with the core (51-05): the
    /// [`inverse_target_matches`] target-identity guard on the `Place`/`DrawBelt` UNDO
    /// arms and on the `Delete` REDO arm (UO-1) — a `Delete` naming a node that is not
    /// the one the record describes. The redo site additionally requires the target to
    /// be LIVE before refusing, so an absent target (an inert `Delete`) still passes.
    /// Both are
    /// returned BEFORE any mutation and BEFORE any record is emitted — a refused undo
    /// is byte-identical, never half-applied. NOTE what a refusal means to the USER:
    /// a sentence. Since Phase 64 the gesture drain (`SimLoop::acquire_input` in
    /// `crates/fabrico-host/src/sim_loop.rs`) answers the gesture envelope's reply with
    /// this verdict rather than discarding it, so `UndoDoesNotFit` reaches the interface as
    /// "That step no longer fits the board." (`Malformed` until plan 88-02) The refusal is still a typed contract
    /// for callers and tests; what changed is that the UI no longer swallows it.
    fn compute_inverse(
        &self,
        target: u64,
        dir: Direction,
    ) -> Result<Vec<EditOp>, CommandError> {
        // The contiguous records sharing the target action (a group is contiguous by
        // construction — each apply/move/undo stamps one action span). Keep the full
        // records (not just ops): the RemovePort inverse looks its captured port up by
        // the record's (action, sequence) in `removed_ports` (PORT-07).
        let group_records: Vec<&EditRecord> =
            self.edit_log.iter().filter(|r| r.action == target).collect();
        let group: Vec<&EditOp> = group_records.iter().map(|r| &r.op).collect();
        // The ids the target action originally minted, in forward mint order. UNDO
        // consumes them from the BACK (it walks records in reverse).
        let minted = self.original_placed.get(&target).cloned().unwrap_or_default();
        // Resolve an id to its CURRENT live id (identity until a re-mint).
        let live = |id: &NodeId| *self.xlate.get(id).unwrap_or(id);

        // CR-01: a self-produced log mints EXACTLY one node per minting op, so a
        // NORMAL group's minting-op count always equals `minted.len()`
        // (= `original_placed[target].len()`). The reverse Undo walk below leans on
        // that parity: it steps `mint_idx` down once per minting op and indexes
        // `minted[mint_idx]` unchecked. A FORGED or corrupted log loaded via the pub
        // `replay` primitive can break the parity — a minting op that folds to a NO-OP
        // (an unknown `Place` kind that `fold_place` ignores; a `DrawWire` whose
        // endpoints are not live) is still reconstructed into a NORMAL undoable group
        // yet mints nothing — which would drive `mint_idx` past 0 into an
        // underflow/OOB panic. Reject the structurally-inconsistent group as a typed
        // `UndoDoesNotFit` error HERE, before any mutation, so a hostile save is always a
        // typed reject and never a panic (the phase no-panic-on-hostile-decode
        // mandate). A legitimate group never trips this — its parity holds by
        // construction — so the happy path is byte-identical.
        //
        // THREE minting ops, not two (63-03). `Place`, `DrawBelt` AND `DrawWire`:
        // plan 63-02 gave `fold_draw_wire` a mint that records into
        // `core.last_tick.placed`, so a group carrying one drawn wire has one more
        // minted id than this filter used to count and EVERY undo of such a group
        // was refused (then `Malformed`). This list is HAND-MAINTAINED and there is no compiler
        // check on it: it must grow the moment ANY new fold starts pushing into
        // `last_tick.placed`. Its twin is the harvest matcher in
        // [`capture_after_fold`](Self::capture_after_fold), and the two must always
        // name the same set — see that method's "Minted-id attribution" docblock for
        // what happens when only one of them is updated.
        //
        // A THIRD hand-maintained correspondence joined these two in 67-03
        // (CONNECT-03 / SEED-006), and it is named here as well as there so neither
        // reader inherits an undocumented coupling: WHICH OPS WRITE
        // `core.last_tick.unlinked`. That set is `{ Rotate, RemovePort }` since 73-06
        // (UNDO-05); it was `{ Rotate }` alone from 67-03 until phase 73. Verified by
        // grep over `tick.rs` rather than by a line citation, which is what the prior
        // wording used and what rotted: `grep -n 'core.last_tick.unlinked'
        // crates/fabrico-core/src/tick.rs` returns exactly two writes, in
        // `fn fold_remove_port` and `fn fold_rotate`. The severed-dock harvest in
        // `capture_after_fold` and the compensating `EditOp::Dock` emits in this
        // function's Undo arms below are ALL written against that two-element set.
        //
        // THIS IS THE MOMENT THE NOTE WARNED ABOUT, and it is recorded as having
        // happened rather than as a future risk. When a second fold started pushing into
        // `last_tick.unlinked`, all three sites had to grow together: the harvest
        // matcher, the compensating arm, and this note. They did, in one commit. Phase
        // 76's SHAPE-06 is the next candidate for a third; it owes the same three edits.
        // Change both, or change neither — now for three lists, not two.
        let minting_ops = group
            .iter()
            .filter(|op| {
                matches!(
                    op,
                    EditOp::Place { .. } | EditOp::DrawBelt { .. } | EditOp::DrawWire { .. }
                )
            })
            .count();
        if minting_ops != minted.len() {
            return Err(CommandError::UndoDoesNotFit);
        }

        let mut out: Vec<EditOp> = Vec::with_capacity(group.len() + 1);

        match dir {
            Direction::Undo => {
                out.push(EditOp::Undo { target_action: target });
                // Prediction clone (12-05): fold each emitted inverse on a THROWAWAY copy
                // of the live core to learn the ids the REAL `append_inverse_group` fold
                // will mint — slotmap mints deterministically from the same allocator
                // state, so a restored belt's `Dock` can freeze the CORRECT freshly
                // re-minted belt + machine ids even though they are minted by EARLIER
                // records in the SAME group (Pitfall 1, the within-group re-mint retarget).
                // No mutation of `self` — `pred` is a local clone discarded on return.
                let mut pred = self.core.clone();
                // Local remap: a restored node's live-at-delete id -> its freshly re-minted
                // id, layered OVER `xlate` (which already maps original-minted -> live).
                let mut remap: BTreeMap<NodeId, NodeId> = BTreeMap::new();
                let mut mint_idx = minted.len();
                // THE SPACE VERDICT WAITS FOR THE WHOLE WALK (phase 86 review, WR-02). Each
                // restore-space check below records here instead of returning, and the
                // refusal is returned only after the reverse walk has finished with no
                // structural `UndoDoesNotFit`. "That space is taken" is false of a record no fold
                // can restore: clearing the space would not bring it back. Folding past a
                // taken cell is harmless, since `pred` is a throwaway clone and nothing is
                // enqueued before `Ok`; the structural checks after it (a mint, a cascade
                // belt's links, a wire's links) do not read occupancy.
                let mut space_taken = false;
                for r in group_records.iter().rev() {
                    match &r.op {
                        // A minting op (Place/Wire/DrawBelt) inverts to a Delete of the
                        // CURRENT live id it minted (resolved through xlate, Pitfall 1).
                        EditOp::Place { kind, cell_x, cell_y, .. } => {
                            mint_idx -= 1;
                            let target = live(&minted[mint_idx]);
                            // TARGET-IDENTITY GUARD (51-05 T-51H-01). See
                            // `inverse_target_matches`. The Place inverse checks kind
                            // AND anchor cell.
                            if !inverse_target_matches(
                                &pred,
                                target,
                                *kind,
                                Some((*cell_x, *cell_y)),
                            ) {
                                return Err(CommandError::UndoDoesNotFit);
                            }
                            let rec = EditOp::Delete {
                                node: target,
                                kind: *kind,
                                cell_x: *cell_x,
                                cell_y: *cell_y,
                                captured: DeletedSubgraph::default(),
                            };
                            fold_predict(&mut pred, &rec);
                            out.push(rec);
                        }
                        EditOp::DrawBelt { .. } => {
                            mint_idx -= 1;
                            // A DrawBelt mints a BELT (no cell — mirror
                            // validate_normalize's Delete capture: belt cell = (0,0)).
                            let target = live(&minted[mint_idx]);
                            // TARGET-IDENTITY GUARD, kind clause ONLY. The cell clause
                            // is DELIBERATELY not applied here: the emitted `Delete`
                            // carries the SENTINEL cell `(0, 0)` above (a belt has no
                            // anchor and `cell_of` returns None for one), so a cell
                            // comparison would reject every legitimate belt undo. The
                            // asymmetry with the Place arm is intentional, not an
                            // oversight — pinned by `belt_undo_still_passes_the_guard`.
                            if !inverse_target_matches(
                                &pred,
                                target,
                                machine_kind::BELT,
                                None,
                            ) {
                                return Err(CommandError::UndoDoesNotFit);
                            }
                            let rec = EditOp::Delete {
                                node: target,
                                kind: machine_kind::BELT,
                                cell_x: 0,
                                cell_y: 0,
                                captured: DeletedSubgraph::default(),
                            };
                            fold_predict(&mut pred, &rec);
                            out.push(rec);
                        }
                        // A DrawWire mints a WIRE (63-03, WIRE-01). Built on the
                        // DrawBelt arm's shape, not the Place arm's: a wire is like a
                        // belt here — it mints, and it has NO anchor cell.
                        EditOp::DrawWire { .. } => {
                            mint_idx -= 1;
                            let target = live(&minted[mint_idx]);
                            // TARGET-IDENTITY GUARD, kind clause ONLY — the SAME
                            // intentional asymmetry the DrawBelt arm documents, not a
                            // second oversight. The emitted `Delete` carries the
                            // SENTINEL cell `(0, 0)` below because a wire has no anchor
                            // and `cell_of` returns `None` for one, so a cell comparison
                            // would reject every legitimate wire undo. The kind clause
                            // still bites: an undo whose target is live but is NOT a
                            // wire is refused rather than deleting whatever now holds
                            // that id (T-63-20).
                            if !inverse_target_matches(
                                &pred,
                                target,
                                machine_kind::WIRE,
                                None,
                            ) {
                                return Err(CommandError::UndoDoesNotFit);
                            }
                            let rec = EditOp::Delete {
                                node: target,
                                kind: machine_kind::WIRE,
                                cell_x: 0,
                                cell_y: 0,
                                captured: DeletedSubgraph::default(),
                            };
                            fold_predict(&mut pred, &rec);
                            out.push(rec);
                        }
                        // Rotate inverts by swapping new_rot/old_rot on the live node,
                        // FOLLOWED BY one compensating `EditOp::Dock` per link this
                        // rotate severed (CONNECT-03 / SEED-006, 67-03).
                        EditOp::Rotate { node, new_rot, old_rot } => {
                            let rec = EditOp::Rotate {
                                node: live(node),
                                new_rot: *old_rot,
                                old_rot: *new_rot,
                            };
                            fold_predict(&mut pred, &rec);
                            out.push(rec);
                            // THE LANDMINE 4 RESOLUTION (Phase 67-03, decision D2).
                            //
                            // `crates/fabrico-core/src/state.rs:1514-1516` warns, in
                            // `rotate_footprint`'s own docblock, verbatim:
                            //
                            //     (A DOCKED
                            //     machine's 4-turn is NOT identity — turn 1 may de-dock
                            //     and the link is not
                            //     restored on turn 4; Landmine 4.)
                            //
                            // That claim is NOT WRONG today, only INCOMPLETE, and this
                            // block is what completes it. `rotate_footprint` still
                            // severs and a four-turn is still not identity AT THE
                            // `GridState` LEVEL — nothing in the core moved. What
                            // changed is that the COMMAND layer now compensates on
                            // UNDO, by emitting N ordinary `EditOp::Dock` records read
                            // off `core.last_tick.unlinked` at fold time. Phase 63
                            // measured that this needs no new op and no new serialized
                            // shape and froze the measurement in
                            // `crates/fabrico-core/tests/footprint_rotation.rs`
                            // (`rotate_severed_docks_are_restored_by_folding_their_recorded_dock_records`).
                            // This closes the product requirement that undoing a rotate
                            // must not leave a belt stranded.
                            //
                            // Said in the one line BOTH files now carry verbatim, so a
                            // single grep finds the core's note and this resolution:
                            // undo re-docks what turn 1 severed.
                            //
                            // The resolution was written HERE and not at `state.rs`
                            // because `crates/fabrico-core` was `FROZEN_PATHS[0]` and
                            // the core-freeze gate diffed the WORKING TREE, so
                            // a comment-only edit there reddened CHECK 2 exactly like a
                            // code edit; its lines 112-114 granted phases 64, 66, 67 and
                            // 68 no exception at all. Milestone v9.0 replaced that
                            // byte-freeze with a declared-moves gate, and Phase 70 plan
                            // 70-04 paid the deferred `state.rs` note, so both sites now
                            // carry the sentence below.
                            //
                            // GREP PARITY. The full Landmine 4 sentence is line-wrapped
                            // across three doc-comment lines in `state.rs` and carries an
                            // EM DASH on the middle one, so no single-line verbatim grep
                            // can match the whole of it. The quotation above is therefore
                            // transcribed line-for-line, which leaves two DASH-FREE
                            // fragments that each sit on ONE line and are each unique
                            // across `crates/`: the second line of the quotation, and the
                            // fourth. A grep for either finds THIS site and `state.rs`'s
                            // original, and nothing else. The THIRD fragment is the
                            // one-line sentence above, added by Phase 70 plan 70-04 once
                            // the thaw made the `state.rs` half of it writable; it is
                            // dash-free and single-line for the same reason. That parity
                            // is not a promise
                            // here — it is a derivation gate, asserted at test time by
                            // reading BOTH files off disk in
                            // `crates/fabrico-command/tests/rotate_undo_redock.rs`
                            // (`the_landmine_4_resolution_is_greppable_from_both_sites`),
                            // so a future re-wording of the frozen text is NAMED rather
                            // than silently passing. Each fragment must therefore appear
                            // EXACTLY ONCE in this file: do not re-quote them below.
                            //
                            // `.get()` and NEVER an index: a forged or hand-edited edit
                            // log loaded through `replay` must degrade to "emit no
                            // compensation", never panic (T-67-03-01). An ABSENT key is
                            // the ordinary case, not an error — a rotate that severed
                            // nothing has an empty capture BY CONSTRUCTION, so this
                            // deliberately does NOT copy the `RemovePort`/`Configure`
                            // arms' capture-miss-is-refusal clause. That refusal belongs
                            // to ops whose fold ALWAYS has something to invert; here it
                            // would refuse the undo of every ordinary rotate on the
                            // board.
                            //
                            // 73-06 SPLIT THE TWO ARMS FURTHER, so do not read them as
                            // the same shape with different words. The `RemovePort` arm
                            // now emits a compensating `Dock` of its own, and it agrees
                            // with this one on the ABSENT case (emit nothing) and
                            // DISAGREES on the present-but-unfoldable case: it REFUSES
                            // the group where this arm `continue`s. The asymmetry is
                            // earned by where each capture comes from. This one can hold
                            // an INVENTION of the throwaway re-fold that the live fold
                            // never had (which is the whole of 67-REVIEW CR-01), so
                            // refusing here would refuse a legitimate undo on a board
                            // whose core holds nodes the edit log never minted. A `RemovePort`
                            // entry exists only because the fold RECORDED a release, so
                            // an entry it cannot invert means the capture broke. Both
                            // policies are written at their own site; neither is
                            // inherited.
                            //
                            // `u.port` is passed through UNTRANSLATED and that is
                            // load-bearing: `UnlinkedDock.port` is ALREADY the LINK key
                            // `fold_dock` wrote and `dock_link_key` produces
                            // (`state.rs:1115-1117`), and `compute_inverse` emits
                            // resolved core `EditOp`s, so it feeds straight into
                            // `EditOp::Dock { port }`. `GridCommand::Unlink.port` is a
                            // DIFFERENT keyspace — a spatial catalog index translated at
                            // validate time. Routing this through `dock_link_key` would
                            // be a bug that TYPECHECKS (T-67-03-03).
                            if let Some(severed) =
                                self.severed_docks.get(&(r.action, r.sequence)).cloned()
                            {
                                for u in severed {
                                    let (belt, node) = (live(&u.belt), live(&u.node));
                                    // TARGET-IDENTITY GUARD (67-REVIEW CR-01, second
                                    // half) — see `compensating_dock_is_foldable` for
                                    // what it checks, why it SKIPS instead of refusing,
                                    // and why it is NOT the CR-01 fix.
                                    if !compensating_dock_is_foldable(&pred, belt, node) {
                                        continue;
                                    }
                                    let redock = EditOp::Dock {
                                        belt,
                                        endpoint: u.endpoint,
                                        node,
                                        port: u.port,
                                    };
                                    fold_predict(&mut pred, &redock);
                                    out.push(redock);
                                }
                            }
                        }
                        // Dock inverts to an Unlink of exactly that directed link.
                        EditOp::Dock { belt, endpoint, node, port } => {
                            let rec = EditOp::Unlink {
                                belt: live(belt),
                                endpoint: *endpoint,
                                node: live(node),
                                port: *port,
                            };
                            fold_predict(&mut pred, &rec);
                            out.push(rec);
                        }
                        // A Delete leg inverts to a re-`Place` of the machine from its
                        // captured footprint, FOLLOWED by re-`Wire` / `DrawBelt`+`Dock`
                        // for every cascade-removed belt — the full subgraph restore
                        // (12-05, Pitfall 2). The machine's live-at-delete id is `node`;
                        // its re-minted id (and each re-minted belt) is harvested from the
                        // prediction fold so dependent records retarget correctly.
                        EditOp::Delete { node, kind, cell_x, cell_y, captured } => {
                            // The resolved footprint: from the capture (real, 12-05) or,
                            // for a default/empty capture (a bare machine, or a hand-built
                            // record), re-resolved from the kind catalog (Place's dims are
                            // a pure function of kind). A REAL capture always has w >= 1
                            // (a footprint is at minimum 1×1), so `is_empty()` (w == 0)
                            // uniquely means "no capture" — see DeletedSubgraph::is_empty
                            // for the pinned invariant (WR-02).
                            // 73-03 (UNDO-01): A DELETE WHOSE TARGET IS ITSELF A BARE
                            // WIRE INVERTS THROUGH `DrawWire`, NEVER THROUGH `Place`.
                            //
                            // `fold_place` has an arm for every kind EXCEPT BELT (1) and
                            // WIRE (8), and its own `_ => return` comment names those two
                            // as the kinds it deliberately never mints. So the `Place` leg
                            // below minted nothing for a wire, `pred.last_tick.placed` came
                            // back empty, and the typed refusal fired. That refusal is
                            // correct BEHAVIOUR on a leg that cannot work; the fix is to
                            // stop taking that leg, not to weaken the refusal.
                            //
                            // `fold_draw_wire` is the leg that CAN work: it mints the node
                            // AND re-writes the canonical `(wire, 0) -> to` link from the
                            // two endpoints it is handed. Those endpoints come off
                            // `captured.self_record` (73-03's appended field) and are
                            // retargeted through the SAME `remap`-then-`live` chain the
                            // cascade-wire leg below uses, because a wire's endpoints NAME
                            // other nodes and one of them may have been re-minted by an
                            // earlier group in this same undo.
                            //
                            // A wire delete carrying NO self-record - every `Delete`
                            // written before this field existed, and any forged one - falls
                            // through to the `Place` leg and is refused there exactly as
                            // before. That is deliberate: an old record does not carry the
                            // endpoints, so the cable genuinely cannot be rebuilt from it,
                            // and inventing endpoints would restore a DIFFERENT cable.
                            let machine_new = if let (
                                machine_kind::WIRE,
                                Some(DeletedSelf::Wire(self_wire)),
                            ) = (*kind, &captured.self_record)
                            {
                                let retarget = |n: NodeId| {
                                    remap.get(&n).copied().unwrap_or_else(|| live(&n))
                                };
                                let draw = EditOp::DrawWire {
                                    from_node: retarget(self_wire.from.0),
                                    from_port: self_wire.from.1,
                                    to_node: retarget(self_wire.to.0),
                                    to_port: self_wire.to.1,
                                };
                                fold_predict(&mut pred, &draw);
                                // The SAME typed refusal shape, for the same reason and
                                // with the same discipline: `fold_draw_wire` mints NOTHING
                                // when either endpoint is not live, which a forged capture
                                // can produce. Refuse the whole group BEFORE any mutation.
                                // Never an `expect`, never an `unwrap`.
                                let Some(&minted) = pred.last_tick.placed.last() else {
                                    return Err(CommandError::UndoDoesNotFit);
                                };
                                out.push(draw);
                                minted
                            } else if let (
                                machine_kind::BELT,
                                Some(DeletedSelf::Belt(self_belt)),
                            ) = (*kind, &captured.self_record)
                            {
                                // 73-05 (UNDO-02): A DELETE WHOSE TARGET IS ITSELF A BARE
                                // BELT INVERTS THROUGH `DrawBelt`, NEVER THROUGH `Place`.
                                //
                                // The wire half of this landed in 73-03 immediately above
                                // and the reasoning is identical: `fold_place` names BELT
                                // and WIRE as the two kinds it deliberately never mints,
                                // so the `Place` leg below minted nothing, the harvest came
                                // back empty and the typed refusal fired. The user pressed
                                // Ctrl+Z on a deleted belt and was told the host could not
                                // read the gesture. `fold_draw_belt` is the leg that CAN
                                // work: it mints the node, sets its `geometry` to the tiles
                                // it is handed and CLAIMS every tile cell back into the
                                // unified occupancy index.
                                //
                                // A ZERO-TILE self-record is REFUSED rather than folded.
                                // Unlike `fold_draw_wire` and `fold_place`, `fold_draw_belt`
                                // mints UNCONDITIONALLY - it would happily produce a belt
                                // with no tiles, no cells and no slots, and this group's
                                // docks would then hang off that. No live gesture can
                                // produce an empty geometry (an empty `DrawBelt` is rejected
                                // at validate time, and the geometry-less `Wire`-minted belt
                                // was removed in 17-02), so an empty one is a forged capture
                                // and restoring it would hand back a DIFFERENT board under
                                // an `Ok` verdict. That is the report-success-while-wrong
                                // shape this phase exists to close, so it is a refusal,
                                // taken BEFORE the fold rather than discovered after it.
                                if self_belt.geometry.is_empty() {
                                    return Err(CommandError::UndoDoesNotFit);
                                }
                                // 86-06 (D-04, WORK-02): the belt's tiles come back only
                                // onto free cells, checked on `pred` before the claim
                                // folds, exactly as the re-Place box below. See
                                // `restore_cells_free`.
                                if !restore_cells_free(
                                    &pred,
                                    self_belt.geometry.iter().map(|t| t.cell),
                                ) {
                                    space_taken = true;
                                }
                                let draw = EditOp::DrawBelt {
                                    tiles: self_belt.geometry.clone(),
                                };
                                fold_predict(&mut pred, &draw);
                                // The SAME typed refusal shape as the wire leg above, for
                                // the same reason and with the same discipline. Never an
                                // `expect`, never an `unwrap`: this `kind` came off a
                                // STORED record that `validate_normalize` never saw.
                                let Some(&minted) = pred.last_tick.placed.last() else {
                                    return Err(CommandError::UndoDoesNotFit);
                                };
                                out.push(draw);
                                minted
                            } else {
                                // The resolved footprint: from the capture (real, 12-05)
                                // or, for a default/empty capture (a bare machine, or a
                                // hand-built record), re-resolved from the kind catalog
                                // (Place's dims are a pure function of kind). A REAL
                                // capture always has w >= 1 (a footprint is at minimum
                                // 1x1), so `is_empty()` (w == 0) uniquely means "no
                                // capture" - see DeletedSubgraph::is_empty for the pinned
                                // invariant (WR-02).
                                //
                                // 73-03, T-73-03-04, AND THIS IS A PANIC THAT WAS LIVE ON
                                // A REACHABLE PATH. `port_catalog` ends in an
                                // `unreachable!()` for every kind outside its allow-set,
                                // and the comment justifying that says `validate_normalize`
                                // refuses such a kind BEFORE the catalog is resolved. That
                                // is true on the FORWARD path and false HERE: this `kind`
                                // came off a STORED RECORD, which `validate_normalize`
                                // never saw. A forged log - or any pre-73-03 log - carrying
                                // `Delete { kind: WIRE, captured: <empty> }` reached the
                                // catalog with kind 8 and PANICKED the whole session on
                                // Ctrl+Z, which is precisely the outcome the
                                // no-panic-on-hostile-decode mandate this function is built
                                // around forbids.
                                //
                                // Refuse with the SAME typed error the un-mintable-kind
                                // case below produces, using the SAME `kind_has_catalog_arm`
                                // allow-set the forward gate uses, so the two paths agree by
                                // construction rather than by memory. The resolution is also
                                // moved INSIDE this branch: the `DrawWire` leg above needs
                                // no catalog at all, and computing one for it was what put
                                // an unreachable-kind lookup on the wire path.
                                if !kind_has_catalog_arm(*kind) {
                                    return Err(CommandError::UndoDoesNotFit);
                                }
                                // 86-02 (D-03, WORK-02): the turn comes back in ONE claim.
                                // The capture records the rotation the machine held and
                                // the re-Place lands the turned box at the logged anchor,
                                // which is the anchor a rotate preserves, so it claims
                                // exactly the cells the machine held at the Delete. The
                                // catalog fallback (an empty capture) is rot 0. No Rotate
                                // follows: a rot-0 claim would write a neighbour's cells
                                // into the occupancy index and the Rotate would then free
                                // them. The captured ports are rot-0 frame, so the re-docks
                                // below face the belts they faced before the Delete.
                                let (w, h, ports, rot) = if captured.is_empty() {
                                    let (f, p) = port_catalog(*kind);
                                    (f.w, f.h, p, 0)
                                } else {
                                    (captured.w, captured.h, captured.ports.clone(), captured.rot)
                                };
                                // 86-06 (D-04, WORK-02): the box comes back only onto
                                // free cells. Read on `pred`, the board this group's
                                // earlier records leave (never the live core, so a move's
                                // undo is not refused against its own cells), and BEFORE
                                // the claim folds, since a claim overwrites the occupancy
                                // it would be read from. The verdict is only recorded
                                // here and returned after the whole walk (WR-02), so a
                                // record no fold can restore at all (a capture-less BELT or
                                // WIRE, or a later record whose links name no belt) keeps
                                // its `UndoDoesNotFit`: "that space is taken" would be false of
                                // it, since clearing the space would not bring it back.
                                // `pred` is a throwaway clone and nothing is enqueued
                                // before `Ok`, so the prediction fold in between changes
                                // nothing the user has. See `restore_cells_free`.
                                let space_free = restore_cells_free(
                                    &pred,
                                    cells_of_footprint((*cell_x, *cell_y), w, h, rot),
                                );
                                let place = EditOp::Place {
                                    kind: *kind,
                                    cell_x: *cell_x,
                                    cell_y: *cell_y,
                                    w,
                                    h,
                                    ports,
                                    rot,
                                };
                                fold_predict(&mut pred, &place);
                                // 63-03: a TYPED refusal, never an `expect`. `fold_place`
                                // mints only for the kinds it knows and returns for every
                                // other (its unknown-kind `_ => return`), so a Delete whose
                                // `kind` is not placeable - a forged byte, or a BELT or WIRE
                                // carrying NO self-record - re-Places NOTHING and left this
                                // walk unwrapping an empty `placed`.
                                // That was a panic on a reachable public gesture pair, which
                                // the no-panic-on-hostile-decode mandate this function is
                                // built around forbids. Restoring a node the fold cannot mint
                                // is not expressible, so the whole group is refused BEFORE
                                // any mutation, exactly like every other structural refusal
                                // here. WIRE reached this arm until 73-03 gave it the
                                // `DrawWire` leg above and BELT until 73-05 gave it the
                                // `DrawBelt` leg; a capture-less record of EITHER kind still
                                // lands here and is still refused, deliberately - the
                                // endpoints and the tiles are simply not in the log, and
                                // inventing them would restore a different cable or a
                                // different belt.
                                let Some(&minted) = pred.last_tick.placed.last() else {
                                    return Err(CommandError::UndoDoesNotFit);
                                };
                                space_taken |= !space_free;
                                out.push(place);
                                minted
                            };
                            remap.insert(*node, machine_new);
                            // 86-03 (WORK-01, D-01, D-02): the deleted node comes back WITH
                            // ITS CONFIG, whatever its kind. The re-`Place` (or re-`DrawBelt`)
                            // above restored the box; the config was captured off the node at
                            // Delete time into `prior_configs` under this record's key (the
                            // `capture_slice` Delete arm, [`config_of_node`]) and is put back
                            // here exactly the way the Configure inverse puts back a prior
                            // config. Plan 76-05 did this for a label alone; this closes
                            // the defect where undoing a Delete lost a Factory's JavaScript
                            // and a Router's route table.
                            //
                            // ALWAYS appended (D-02), even when the captured config equals the
                            // kind's default: one shape for every Delete undo, so there is no
                            // "equal, so skip" case to get wrong. A captured config of the
                            // wrong kind for the re-minted node (a forged log) is skipped, not
                            // folded (T-86-07). A capture MISS restores the node at its
                            // defaults rather than refusing (76-05's rule), which keeps the
                            // trimmed-log legs of `undo_on_demo_board.rs` working; a deleted
                            // bare belt then still gets its pace from its own self-record.
                            let captured_config = self
                                .prior_configs
                                .get(&(r.action, r.sequence))
                                .cloned()
                                .or(match &captured.self_record {
                                    Some(DeletedSelf::Belt(self_belt)) => Some(MachineConfig::Belt {
                                        ticks_per_slot: self_belt.ticks_per_slot,
                                    }),
                                    _ => None,
                                });
                            if let Some(config) = captured_config
                                && config_variant_matches_live_kind(&pred, machine_new, &config)
                            {
                                // T-86-15: a label's re-Configure re-grows its box past
                                // the captured one, so the space guard also reads the box
                                // it claims, on `pred` before the claim folds. Recorded,
                                // never returned here (WR-02). See
                                // `label_regrow_cells_free`.
                                space_taken |= !label_regrow_cells_free(&pred, machine_new, &config);
                                let rec = EditOp::Configure {
                                    node: machine_new,
                                    config,
                                    code_hash: [0u8; 32],
                                };
                                fold_predict(&mut pred, &rec);
                                out.push(rec);
                            }
                            // 73-05 (UNDO-02 / UNDO-03): re-`Dock` every link the deleted
                            // node ITSELF was incident to, in the capture's own order.
                            //
                            // This runs AFTER the `remap.insert` above and not inside the
                            // branch that minted `machine_new`, because the other end of
                            // each link may be a node re-minted by an EARLIER group in this
                            // same undo, and the retarget below needs both maps populated.
                            //
                            // RULING R-20, AND IT IS THE WHOLE REASON THE RECORD EXISTS.
                            // The belt id here is `*node` - the `Delete` record's OWN field
                            // - and `identify_belt` is never consulted. `identify_belt`
                            // infers a belt's id from its incident links; handed a bare
                            // belt's single link and the deleted node's id as `machine`,
                            // its one-link fast path returns the NON-machine endpoint,
                            // which is the DOCKED MACHINE. `remap` would then map that
                            // machine onto the freshly minted belt and every retarget in
                            // this group would aim at the wrong node - with no error at
                            // all. The cascade loop below keeps using `identify_belt`,
                            // which is correct there: a cascade record carries no id and
                            // the deleted MACHINE really is the other endpoint.
                            //
                            // The direction rule is the cascade belt leg's, verbatim: the
                            // node as link SOURCE is `Head` (LOAD), the node as link TARGET
                            // is `Tail` (OFFLOAD). The wire half skips the ONE link
                            // `fold_draw_wire` re-wrote for itself; see
                            // `self_record_links` for why that skip is load-bearing.
                            for (endpoint, mnode, mport) in
                                self_record_links(&captured.self_record, *node)?
                            {
                                let mnode_live =
                                    remap.get(&mnode).copied().unwrap_or_else(|| live(&mnode));
                                let dock = EditOp::Dock {
                                    belt: machine_new,
                                    endpoint,
                                    node: mnode_live,
                                    port: mport,
                                };
                                fold_predict(&mut pred, &dock);
                                out.push(dock);
                            }
                            // Re-create each cascade belt in capture order (the same
                            // `docked_wire_belts` order the capture recorded), so the
                            // prediction fold's mint order matches the real fold's.
                            // Plan 88-02 (WINDOWS 228, D-04): the walk and its skip are
                            // `pair_captured_belts_with_minted`'s, the ONE walk
                            // `reconstruct_projection` also pairs re-minted ids with, so the two
                            // cannot pair a captured belt with a different minted id again.
                            pair_captured_belts_with_minted(&captured.belts, |belt| {
                                // 17-02: node→node Wire is removed, so every CASCADE belt
                                // is a DRAWN belt (non-empty geometry). A cascade capture
                                // with empty geometry can no longer be produced; skip it
                                // defensively (panic-free) rather than reconstruct a
                                // removed Wire.
                                //
                                // 73-03 CORRECTION: this comment was written when only
                                // CASCADE belts could reach here, and that is no longer the
                                // only bare-belt record in a capture. `self_record` can now
                                // carry the deleted node's OWN `DeletedBelt`. It does NOT
                                // arrive in this loop - it is a separate field and plan
                                // 73-05 owns its restore leg - so the reasoning above still
                                // holds for everything this loop sees. Said out loud
                                // because a reader who finds the new field would otherwise
                                // have to re-derive that this loop is unaffected.
                                // (The empty-geometry skip lives in the helper, shared with
                                // the projection's re-mint walk: plan 88-02, WINDOWS 228.)
                                // 74-03 (T-74-14): a record whose links name no belt is a
                                // MALFORMED capture, refused before any mutation. It used
                                // to answer `machine` and restore a board whose re-mint
                                // table called the machine a belt, reporting Ok. The
                                // refusal is asked AFTER the geometry skip so a legitimate
                                // empty-geometry record keeps degrading exactly as it did.
                                let Some(belt_orig) = identify_belt(&belt.links, *node)
                                else {
                                    return Err(CommandError::UndoDoesNotFit);
                                };
                                // 86-06 (D-04, WORK-02): every cascade belt's tiles
                                // come back only onto free cells, checked on `pred` (which
                                // already holds the machine re-Placed above and every
                                // earlier cascade belt) before this one's claim folds.
                                // See `restore_cells_free`.
                                if !restore_cells_free(&pred, belt.geometry.iter().map(|t| t.cell)) {
                                    space_taken = true;
                                }
                                // Drawn belt: re-`DrawBelt` (re-mints + re-claims its
                                // tile cells) then re-`Dock` each incident link to the
                                // freshly re-minted belt + retargeted machine endpoint.
                                let draw = EditOp::DrawBelt {
                                    tiles: belt.geometry.clone(),
                                };
                                fold_predict(&mut pred, &draw);
                                let belt_new = *pred
                                    .last_tick
                                    .placed
                                    .last()
                                    .expect("the re-DrawBelt re-mints the belt");
                                remap.insert(belt_orig, belt_new);
                                out.push(draw);
                                for &(fnode, fport, tnode, tport) in &belt.links {
                                    // Link direction implies the dock end: belt as the
                                    // link SOURCE = Head (LOAD); belt as the TARGET =
                                    // Tail (OFFLOAD). The other endpoint is the machine.
                                    let (endpoint, mnode, mport) = if fnode == belt_orig {
                                        (BeltEnd::Head, tnode, tport)
                                    } else {
                                        (BeltEnd::Tail, fnode, fport)
                                    };
                                    let mnode_live =
                                        remap.get(&mnode).copied().unwrap_or_else(|| live(&mnode));
                                    let dock = EditOp::Dock {
                                        belt: belt_new,
                                        endpoint,
                                        node: mnode_live,
                                        port: mport,
                                    };
                                    fold_predict(&mut pred, &dock);
                                    out.push(dock);
                                }
                                // 86-03 (WORK-01 "every other setting", research Pitfall
                                // 2): the cascade belt comes back at ITS OWN PACE. A
                                // `DrawBelt` mints at the default pace, so the pace the
                                // capture read off the board the Delete folded against
                                // (`DeletedBelt.ticks_per_slot`, plan 86-02) is put back
                                // after the re-draw and its re-docks. Always, as for the
                                // deleted node itself (D-02), so every Delete undo has one
                                // shape.
                                let pace = EditOp::Configure {
                                    node: belt_new,
                                    config: MachineConfig::Belt {
                                        ticks_per_slot: belt.ticks_per_slot,
                                    },
                                    code_hash: [0u8; 32],
                                };
                                fold_predict(&mut pred, &pace);
                                out.push(pace);
                                Ok(Some(belt_new))
                            })?;
                            // 63-06: re-create each cascade-removed WIRE, in the same
                            // `docked_wires` capture order. AFTER the machine's re-Place
                            // and after the belts, because a wire's endpoints NAME the
                            // machine and must resolve to its re-minted id.
                            //
                            // A wire needs one record and no re-Docks: `fold_draw_wire`
                            // re-mints the node AND re-writes the single
                            // `(wire, 0) -> to` link from the endpoints it is handed, so
                            // the captured `links` list is the audit record of the
                            // teardown rather than an input here (see `DeletedWire`).
                            //
                            // Both endpoints go through the SAME two-step retarget the
                            // belt docks use - the local `remap` first (the machine just
                            // re-minted in THIS group), then `live(..)` (a node re-minted
                            // by an earlier group). Before this plan the whole leg did
                            // not exist and deleting a wired machine was not undoable at
                            // all; plan 63-03 left a typed refusal (`UndoDoesNotFit` since 88-02) for the
                            // narrower case of undoing a delete OF a wire, and that
                            // refusal is still correct and still stands, because a
                            // `Delete { kind: WIRE }` re-Places nothing.
                            for wire in &captured.wires {
                                let retarget = |n: NodeId| {
                                    remap.get(&n).copied().unwrap_or_else(|| live(&n))
                                };
                                let draw = EditOp::DrawWire {
                                    from_node: retarget(wire.from.0),
                                    from_port: wire.from.1,
                                    to_node: retarget(wire.to.0),
                                    to_port: wire.to.1,
                                };
                                fold_predict(&mut pred, &draw);
                                // Assert the re-mint rather than assume it.
                                // `fold_draw_wire` mints NOTHING when either endpoint is
                                // not live, which a forged capture can produce, and a
                                // short mint breaks the positional parity
                                // `capture_after_fold` relies on. `fold_predict` folds ONE
                                // op per tick and `last_tick.placed` is reset each call,
                                // so an empty `placed` here means THIS record minted
                                // nothing - the group is refused BEFORE any mutation, the
                                // same no-panic discipline the re-Place harvest above was
                                // given in 63-03, never an `expect`.
                                let Some(&wire_new) = pred.last_tick.placed.last() else {
                                    return Err(CommandError::UndoDoesNotFit);
                                };
                                out.push(draw);
                                // 73-05 (UNDO-03): re-`Dock` every OTHER link this wire was
                                // incident to. `fold_draw_wire` writes exactly ONE link,
                                // the canonical `(wire, 0) -> to`; a `Dock` aimed at the
                                // wire writes `link((node, port), (wire, 0))`, which is
                                // precisely the shape that fold never writes. Until this
                                // plan those links were captured and then never read, so
                                // the undo returned `Ok` and handed back a DIFFERENT graph.
                                // That silence is what made it the worst shape in this
                                // cluster.
                                for (endpoint, mnode, mport) in
                                    non_canonical_wire_links(wire)?
                                {
                                    let mnode_live = remap
                                        .get(&mnode)
                                        .copied()
                                        .unwrap_or_else(|| live(&mnode));
                                    let dock = EditOp::Dock {
                                        belt: wire_new,
                                        endpoint,
                                        node: mnode_live,
                                        port: mport,
                                    };
                                    fold_predict(&mut pred, &dock);
                                    out.push(dock);
                                }
                            }
                        }
                        // AddPort inverts to a RemovePort of the slot the RECORD says the
                        // port went into. Not a minting op - `mint_idx` untouched.
                        //
                        // 73-03: THIS READS THE RECORD, NOT THE LIVE LIST LENGTH. Until
                        // this plan the arm computed `ports_of(node).len() - 1`, i.e. "the
                        // last slot", which was correct only because `fold_add_port` could
                        // only ever append. Now that an `AddPort` can name a middle slot -
                        // which is the entire point of the field, since the inverse of a
                        // `RemovePort` emits exactly such a record - "the last slot" would
                        // remove the WRONG port, and silently: the list length would still
                        // come back right, so every count-based assertion would pass.
                        //
                        // Reading the record also removes a dependency on `pred` being in
                        // any particular state, which is strictly the more honest inverse:
                        // the inverse of "insert at N" is "remove at N", stated rather than
                        // re-derived from a board that may have moved.
                        EditOp::AddPort { node, index, .. } => {
                            // 74.1-16: THE PRE-ADD BOX AND ANCHOR, so the inverse shrinks a
                            // grown box and moves a shifted anchor back (a forward removal
                            // never shrinks). Read off `added_port_boxes` by this record's
                            // (action, sequence), with the `RemovePort` arm's capture-miss
                            // policy: a miss on a LIVE node means the projection lost id
                            // alignment, so the group is refused, typed, before any
                            // mutation; a node absent from `pred` is a fold no-op with
                            // nothing to invert, and its inverse folds to a no-op too.
                            let node_live = live(node);
                            let restore = self.added_port_boxes.get(&(r.action, r.sequence)).copied();
                            if restore.is_none() && pred.state.node(node_live).is_some() {
                                return Err(CommandError::UndoDoesNotFit);
                            }
                            let rec = EditOp::RemovePort { node: node_live, index: *index, restore };
                            fold_predict(&mut pred, &rec);
                            out.push(rec);
                            // 74.1-12 (CORNER-06): THE COMPENSATING DOCKS, AFTER THE
                            // `RemovePort` AND NEVER BEFORE IT. Since 74.1-12
                            // `fold_add_port` releases a belt dock whose re-seated port no
                            // longer faces its belt, so this inverse owes a re-`Dock` per
                            // release, exactly as the `RemovePort` arm below does. The
                            // `RemovePort` folds first because each `Dock` carries the
                            // PRE-insert link key, which is the keyspace that removal
                            // restores. The capture-miss and refusal policy is the
                            // `RemovePort` arm's (ABSENT entry: emit nothing; PRESENT entry
                            // that cannot be folded: refuse the group, typed, before any
                            // mutation), and `u.port` passes through untranslated for the
                            // reason stated there; read that arm, it is not repeated here.
                            if let Some(severed) =
                                self.severed_docks.get(&(r.action, r.sequence)).cloned()
                            {
                                for u in severed {
                                    let (belt, node) = (live(&u.belt), live(&u.node));
                                    if !compensating_dock_is_foldable(&pred, belt, node) {
                                        return Err(CommandError::UndoDoesNotFit);
                                    }
                                    let redock = EditOp::Dock {
                                        belt,
                                        endpoint: u.endpoint,
                                        node,
                                        port: u.port,
                                    };
                                    fold_predict(&mut pred, &redock);
                                    out.push(redock);
                                }
                            }
                        }
                        // RemovePort inverts to an AddPort that re-appends the EXACT
                        // removed Port (role+medium), recovered from `removed_ports` by
                        // this record's (action, sequence) — the NON-serialized capture
                        // rebuilt by reconstruct_projection (survives save/load).
                        //
                        // CAPTURE-MISS = REFUSAL (51-05, threat T-51H-03). This arm used
                        // to SKIP on a missing capture, which is the precise mechanism of
                        // the reported defect: the inverse group was emitted with the
                        // AddPort absent while the undo cursor still moved, so the user
                        // spent an undo step and got nothing back. The discriminator is
                        // `pred` — the walked-forward live core — NOT the capture map: if
                        // the target node is LIVE, the logged removal really did take a
                        // port off a real node and something is owed back, so a missing
                        // capture means the projection has lost id alignment with the core
                        // (the class 51-04 fixed the live instance of, and which is
                        // reached by a session rebuilt by `replay_two_logs` over a core
                        // holding nodes its edit log never minted). Refuse.
                        // A node ABSENT from `pred` is a genuine fold no-op with nothing to
                        // invert — skip exactly as before (panic-free; T-36-06).
                        //
                        // Note on the SELF-PRODUCED path: `validate_normalize`'s RemovePort
                        // gate rejects an out-of-range index BEFORE any record is appended,
                        // so a capture-miss on an aligned session is impossible by
                        // construction — which is why treating a miss as a misalignment is
                        // sound rather than trigger-happy. A forged log carrying an
                        // out-of-range index against a live node lands here too and is
                        // refused, on the same forged-log philosophy as the CR-01 parity
                        // reject above.
                        //
                        // WHAT THE USER SEES on a refusal: a sentence naming the reason.
                        // The gesture drain (`SimLoop::acquire_input`) answers the gesture
                        // envelope's reply with this verdict rather than discarding it, so
                        // `UndoDoesNotFit` crosses the wire and Ctrl+Z reads "That step no
                        // longer fits the board." This turns an undo that silently restored
                        // nothing WHILE SPENDING A STEP into a typed reject that spends
                        // nothing and says so - still NOT a repair of the post-load path.
                        EditOp::RemovePort { node, .. } => {
                            let node_live = live(node);
                            // 73-03: THE CAPTURE NOW CARRIES THE INDEX AS WELL AS THE
                            // PORT, and the inverse names it. Before this plan the emitted
                            // `AddPort` had no index at all and `fold_add_port` appended,
                            // so undoing the removal of a MIDDLE output put it back LAST
                            // and silently renumbered every port after it. The port count
                            // came back right, which is why nothing caught it: only the
                            // ORDER was wrong, and order is what every belt dock key is.
                            //
                            // The index is read off the CAPTURE rather than off the
                            // record. Both say the same thing by construction - the
                            // capture is taken as `ports_of(node)[index]` using the
                            // record's own index - and the capture is the one that is
                            // authoritative on the live path by construction, so the two
                            // are kept from becoming two rules by only ever consulting
                            // one of them.
                            if let Some((port, index)) =
                                self.removed_ports.get(&(r.action, r.sequence)).copied()
                            {
                                // 74.1-16: ON ITS CAPTURED SLOT, never the first free one,
                                // so undoing two removals in turn puts both ports back on
                                // their own rows. `port` carries the slot it held.
                                let rec = EditOp::AddPort {
                                    node: node_live,
                                    port,
                                    index,
                                    seat: PortSeat::Captured,
                                };
                                fold_predict(&mut pred, &rec);
                                out.push(rec);
                            } else if pred.state.node(node_live).is_some() {
                                return Err(CommandError::UndoDoesNotFit);
                            }
                            // 73-06 (UNDO-05): THE COMPENSATING DOCK, EMITTED AFTER THE
                            // `AddPort` AND NEVER BEFORE IT. Since 73-06 `fold_remove_port`
                            // RELEASES the dock that was on the removed port and records it
                            // on `core.last_tick.unlinked`, so the inverse owes a re-`Dock`
                            // exactly as the `Rotate` arm does. The order is not a
                            // preference: the `Dock`'s key names a port, and until the
                            // `AddPort` above has folded that port does not exist, so a
                            // `Dock` emitted first would fold against the shrunk list and
                            // land on the wrong physical output or on none.
                            //
                            // THE CAPTURE-MISS POLICY HERE IS THE OPPOSITE OF THE `Rotate`
                            // ARM'S, AND THAT IS DELIBERATE (R-28). Read them side by side
                            // before assuming they match, because they read almost the same
                            // and mean different things:
                            //
                            //   - ABSENT entry => emit no `Dock` and carry on. A
                            //     `RemovePort` of an UNDOCKED port severed nothing, so
                            //     there is genuinely nothing to invert. Same as `Rotate`.
                            //   - PRESENT entry that cannot be turned into a foldable
                            //     `Dock` => REFUSE THE WHOLE GROUP, typed, before any
                            //     mutation. NOT the same as `Rotate`. The `Rotate` arm
                            //     SKIPS an unfoldable compensation because its capture can
                            //     be an invention of the throwaway re-fold that the live
                            //     fold never had. Here, an entry exists only because the
                            //     fold RECORDED a release, so if it cannot be inverted the
                            //     capture itself is broken and silently restoring the port
                            //     without its belt would hand back a DIFFERENT board while
                            //     reporting success.
                            //
                            // `u.port` is passed through UNTRANSLATED, for the reason the
                            // `Rotate` arm states at length: `UnlinkedDock.port` is ALREADY
                            // the LINK key `fold_dock` wrote and `dock_link_key` produces,
                            // while `GridCommand::Unlink.port` is a DIFFERENT keyspace (a
                            // spatial catalog index translated at validate time). Routing
                            // this through `dock_link_key` would be a bug that TYPECHECKS
                            // (T-73-06-06).
                            if let Some(severed) =
                                self.severed_docks.get(&(r.action, r.sequence)).cloned()
                            {
                                for u in severed {
                                    let (belt, node) = (live(&u.belt), live(&u.node));
                                    if !compensating_dock_is_foldable(&pred, belt, node) {
                                        return Err(CommandError::UndoDoesNotFit);
                                    }
                                    let redock = EditOp::Dock {
                                        belt,
                                        endpoint: u.endpoint,
                                        node,
                                        port: u.port,
                                    };
                                    fold_predict(&mut pred, &redock);
                                    out.push(redock);
                                }
                            }
                            // 73-12 (73-REVIEW CR-01): THE COMPENSATING `Configure`,
                            // EMITTED AFTER THE `AddPort` AND ONLY WHEN THE MIRROR OWES
                            // SOMETHING IT CANNOT PAY.
                            //
                            // `fold_remove_port` re-points `Router.routes` and
                            // `Router.default` as a derived consequence of the port list
                            // shrinking. Two of its three arms are reversible by
                            // `fold_add_port`'s mirror (a key ABOVE the removed one
                            // decrements and increments back). The third is NOT: a rule
                            // naming the removed key is DROPPED and a `default` naming it
                            // becomes `None`, and no shift can invent either back. So one
                            // Ctrl+Z restored the port, the docks and the shifted rules,
                            // returned `Ok(())`, and handed the user a board short one
                            // rule and its fallback - silently, because every count came
                            // back right.
                            //
                            // ORDER: strictly after the `AddPort`. `validate_normalize`'s
                            // ROUTE-03 gate refuses a table naming an output the node does
                            // not have, and the fold's own re-point reads the live Out
                            // count; a `Configure` emitted before the port is back would
                            // be describing a machine that does not exist yet.
                            //
                            // WHY IT IS CONDITIONAL, and why the condition is a COMPARISON
                            // rather than a re-derivation of the fold's rule. `pred` is the
                            // walked-forward predicted core and the `AddPort` above has
                            // already folded into it, mirror included. So `pred` holds
                            // exactly what the undo will produce WITHOUT this record. If
                            // that already equals the captured table, the mirror paid in
                            // full and emitting a `Configure` would add a record that
                            // changes nothing - moving every frozen fixture that undoes a
                            // Router port edit for no behavioural reason. Asking the
                            // predicted board rather than restating "did an arm drop
                            // something" keeps ONE rule in `fold_remove_port` instead of a
                            // second copy here that can drift from it.
                            //
                            // CAPTURE-MISS IS NOT A REFUSAL HERE, and that is the opposite
                            // of the `Configure` arm below. A `RemovePort` on a non-Router
                            // legitimately captures nothing, so an absent entry is the
                            // ordinary case rather than evidence of lost id alignment.
                            if let Some(MachineConfig::Router { routes, default }) =
                                self.prior_configs.get(&(r.action, r.sequence)).cloned()
                                && router_table_of(&pred, node_live)
                                    != Some(MachineConfig::Router {
                                        routes: routes.clone(),
                                        default,
                                    })
                            {
                                let rec = EditOp::Configure {
                                    node: node_live,
                                    config: MachineConfig::Router { routes, default },
                                    // The blake3 fence: this crate never hashes. The HOST
                                    // re-stamps a Factory config on the Undo enqueue path;
                                    // a Router config carries no source, so the zero is
                                    // final rather than a placeholder.
                                    code_hash: [0u8; 32],
                                };
                                fold_predict(&mut pred, &rec);
                                out.push(rec);
                            }
                        }
                        // Configure inverts to a Configure carrying the PRIOR effective
                        // config for this node, recovered from `prior_configs` by this
                        // record's (action, sequence) — the NON-serialized capture rebuilt
                        // by reconstruct_projection (survives save/load, CFG-02). The
                        // inverse always zeroes `code_hash` here (the blake3 fence — this
                        // crate never hashes); the HOST re-stamps it with blake3(source) on
                        // the Undo enqueue path (`input_apply::stamp_factory_code_hashes`)
                        // before folding, so a Factory undo persists the correct cert hash
                        // (F2). Not a minting op — `mint_idx` untouched.
                        //
                        // CAPTURE-MISS = REFUSAL, the `removed_ports` twin (51-05, threat
                        // T-51H-03) — same rationale, same cost, one extra clause. A
                        // Configure against a node whose KIND does not match the record's
                        // `MachineConfig` variant folds to a documented panic-free no-op
                        // (T-39-FOLD-PANIC) that `validate_normalize` deliberately accepts
                        // (its gate is resolve-only), so such an undo has genuinely nothing
                        // to invert and must still SKIP — that is the negative control
                        // `wrong_kind_configure_undo_still_skips_not_refuses` pins, and it
                        // is what keeps this from being a blanket "no capture -> reject".
                        // Only a LIVE node whose kind DOES match the variant is refused:
                        // there the fold really did overwrite a config and the missing
                        // capture can only mean a misaligned projection.
                        // (`MachineConfig::Source` always captures — the running
                        // last-trigger map defaults to `Webhook` and neither capture path
                        // can `continue` on it — so a Source can reach the miss path only
                        // on a misaligned projection; it is listed for totality.)
                        //
                        // WHAT THE USER SEES on a refusal: a sentence. Since Phase 64 the
                        // gesture drain (`SimLoop::acquire_input`) answers the gesture
                        // envelope's reply with this verdict instead of discarding it, so
                        // Ctrl+Z reads "The host could not carry out that gesture." Bounded and
                        // said out loud, still not a repair.
                        EditOp::Configure { node, config, .. } => {
                            let node_live = live(node);
                            if let Some(prior) =
                                self.prior_configs.get(&(r.action, r.sequence)).cloned()
                            {
                                let rec = EditOp::Configure {
                                    node: node_live,
                                    config: prior,
                                    code_hash: [0u8; 32],
                                };
                                fold_predict(&mut pred, &rec);
                                out.push(rec);
                            } else if config_variant_matches_live_kind(&pred, node_live, config) {
                                return Err(CommandError::UndoDoesNotFit);
                            }
                        }
                        // An Unlink inverts to the Dock that created the link (63-05).
                        // The record carries all four fields the dock froze — including
                        // the resolved LINK KEY port, which is the keyspace `fold_dock`
                        // consumes verbatim — so the inverse is expressible from the
                        // record alone, with both node ids retargeted through `live(..)`.
                        //
                        // `Unlink` sat in the skip arm below until this plan, on the
                        // stated grounds that it never appears in a normal undoable
                        // group. That was true only while the undo driver was its sole
                        // producer. `GridCommand::Unlink` makes it a normal group member,
                        // and leaving it skipped would have shipped a phase whose own new
                        // command produces an action the same phase's undo silently
                        // ignores.
                        EditOp::Unlink { belt, endpoint, node, port } => {
                            let rec = EditOp::Dock {
                                belt: live(belt),
                                endpoint: *endpoint,
                                node: live(node),
                                port: *port,
                            };
                            fold_predict(&mut pred, &rec);
                            out.push(rec);
                        }
                        // What is left is the two LINEAGE MARKERS: neither appears in a
                        // NORMAL (undoable) action group — a normal group is only ever
                        // Place/Delete/Rotate/DrawBelt/DrawWire/Dock/Unlink (+ the
                        // port/config edits above). Skip both defensively (panic-free).
                        // The history seal (85-05, D-10) is never in an undoable group
                        // either: `reconstruct_projection` gives it its own arm.
                        EditOp::Undo { .. } | EditOp::Redo { .. } | EditOp::SealHistory => {}
                    }
                }
                // Every record walked with no structural refusal: only now is "that space is
                // taken" the true answer (WR-02).
                if space_taken {
                    return Err(CommandError::UndoSpaceTaken);
                }
            }
            Direction::Redo => {
                out.push(EditOp::Redo { target_action: target });
                for op in &group {
                    match op {
                        // Re-apply the original op, retargeting every resolved endpoint
                        // through xlate (a minting op re-mints a fresh id; the REDO
                        // marker's xlate refresh — reconstruct_projection — captures the
                        // original->re-minted remap positionally).
                        EditOp::Place { .. } | EditOp::DrawBelt { .. } => {
                            out.push((*op).clone());
                        }
                        // A DrawWire re-applies as ITS OWN arm rather than joining the
                        // two above (63-03), and the reason is the retargeting: a Place
                        // carries a cell and a DrawBelt carries tiles, so neither holds
                        // a node reference that an intervening undo could have
                        // re-minted. A DrawWire holds TWO resolved `NodeId` endpoints,
                        // so it must run both through `live(..)` exactly the way the
                        // Dock arm below runs its `belt` and `node`.
                        EditOp::DrawWire { from_node, from_port, to_node, to_port } => {
                            out.push(EditOp::DrawWire {
                                from_node: live(from_node),
                                from_port: *from_port,
                                to_node: live(to_node),
                                to_port: *to_port,
                            });
                        }
                        EditOp::Rotate { node, new_rot, old_rot } => {
                            out.push(EditOp::Rotate {
                                node: live(node),
                                new_rot: *new_rot,
                                old_rot: *old_rot,
                            });
                        }
                        EditOp::Dock { belt, endpoint, node, port } => {
                            out.push(EditOp::Dock {
                                belt: live(belt),
                                endpoint: *endpoint,
                                node: live(node),
                                port: *port,
                            });
                        }
                        // TARGET-IDENTITY GUARD, REDO DIRECTION (UO-1) — the mirror of
                        // T-51H-01's undo-side guard on the Place/DrawBelt arms. This is
                        // the THIRD (and last) `Delete`-emitting seam in `compute_inverse`
                        // and the only one T-51H-01 left open: a redo re-deletes a machine
                        // an undo restored, so if `xlate` names the WRONG node the redo
                        // destroys a bystander with an `Ok` verdict — the same measured
                        // symptom, in the opposite direction. Reachability is narrower (it
                        // needs an ALREADY-misaligned projection AND a prior SUCCESSFUL
                        // undo of a Delete-bearing group, whose `xlate` refresh at the
                        // `Undo` marker arm of `reconstruct_projection` is where the wrong
                        // id enters), which is why it was rated medium; it is guarded
                        // anyway because a guard on one direction of a symmetric operation
                        // is not a guard.
                        //
                        // DISCRIMINATED exactly like the `RemovePort`/`Configure`
                        // capture-miss guards, and deliberately NOT like a blanket reject:
                        // refuse only when the wrong target can be PROVEN — the node is
                        // LIVE and its kind (or anchor) disagrees with the record. A target
                        // ABSENT from the core is left alone: the emitted `Delete` is a
                        // fold no-op that destroys nothing, so refusing there would only
                        // over-block, and an over-strict redo guard is a worse defect than
                        // the one this closes.
                        //
                        // Reads come from `self.core` rather than a walked-forward `pred`
                        // (the Undo arm's device) because the Redo arm emits its group
                        // WITHOUT a prediction clone, and no op a redo group can carry
                        // (Place/DrawBelt mint; Rotate/Dock/port/config edits mutate
                        // neither kind nor ANCHOR) can change an existing node's identity
                        // mid-group. Where the two could differ — a node minted by an
                        // EARLIER record of this same group — `self.core` reads ABSENT and
                        // the guard skips, which is the safe direction.
                        //
                        // The cell clause is skipped for BELT for the SAME reason the
                        // DrawBelt undo arm skips it: a belt has no anchor (`cell_of`
                        // returns `None` for one) and `validate_normalize` writes the
                        // sentinel `(0, 0)` into its Delete record, so comparing cells
                        // would reject every legitimate belt redo. Pinned by
                        // `belt_delete_redo_is_not_refused_by_the_sentinel_cell`.
                        //
                        // WHAT THE USER SEES on a refusal: a sentence. Since Phase 64 the
                        // gesture drain (`SimLoop::acquire_input`) answers the gesture
                        // envelope's reply with this verdict, so a refused Ctrl+Shift+Z
                        // reads "The host could not carry out that gesture." Same outcome as the
                        // undo side (T-51H-04); strictly better than destroying a bystander.
                        EditOp::Delete { node, kind, cell_x, cell_y, captured } => {
                            let node_live = live(node);
                            let cell = if *kind == machine_kind::BELT {
                                None
                            } else {
                                Some((*cell_x, *cell_y))
                            };
                            if self.core.state.node(node_live).is_some()
                                && !inverse_target_matches(&self.core, node_live, *kind, cell)
                            {
                                return Err(CommandError::UndoDoesNotFit);
                            }
                            out.push(EditOp::Delete {
                                node: node_live,
                                kind: *kind,
                                cell_x: *cell_x,
                                cell_y: *cell_y,
                                captured: captured.clone(),
                            });
                        }
                        // Re-apply a port edit, retargeting the node through xlate (the
                        // undo restored the port list, so a RemovePort's index is valid
                        // again; an AddPort re-appends the same port). PORT-07.
                        EditOp::AddPort { node, port, index, seat } => {
                            // 73-03: the index rides through UNCHANGED, like the port. A
                            // redo re-applies the ORIGINAL record, and the original record
                            // is what named the slot. 74.1-16: so does its seat (`Auto` on
                            // every forward record), which on the board the undo restored
                            // lands on the same first free slot.
                            out.push(EditOp::AddPort {
                                node: live(node),
                                port: *port,
                                index: *index,
                                seat: *seat,
                            });
                        }
                        EditOp::RemovePort { node, index, restore } => {
                            out.push(EditOp::RemovePort {
                                node: live(node),
                                index: *index,
                                restore: *restore,
                            });
                        }
                        // Re-apply the ORIGINAL (new) config, retargeting the node through
                        // xlate. The original `code_hash` (already blake3(source), stamped
                        // host-side when the forward Configure was applied) rides through
                        // unchanged; the host's re-stamp on the Redo enqueue path is
                        // idempotent, so redo restores exactly what the forward Configure
                        // set (CFG-02, F2).
                        EditOp::Configure { node, config, code_hash } => {
                            out.push(EditOp::Configure {
                                node: live(node),
                                config: config.clone(),
                                code_hash: *code_hash,
                            });
                        }
                        // Re-apply the Unlink, retargeting BOTH resolved endpoints
                        // through xlate (63-05). The `port` is already a resolved link
                        // key and never re-translates: it is in the keyspace `fold_dock`
                        // wrote, not the catalog keyspace the command carried.
                        EditOp::Unlink { belt, endpoint, node, port } => {
                            out.push(EditOp::Unlink {
                                belt: live(belt),
                                endpoint: *endpoint,
                                node: live(node),
                                port: *port,
                            });
                        }
                        // The two lineage markers and the history seal (85-05) never
                        // appear in a normal redoable group; skip them defensively
                        // (panic-free).
                        EditOp::Undo { .. } | EditOp::Redo { .. } | EditOp::SealHistory => {}
                    }
                }
            }
        }
        Ok(out)
    }

    /// Stamp every record in a pre-built inverse `group` under ONE new shared action
    /// at the SAME `core.tick` (mirroring [`apply_under_action`](Self::apply_under_action)'s
    /// stamp block), push them, fold the WHOLE slice via ONE `advance_edits` (one
    /// tick), re-project the view, and rebuild the undo/redo projection. The shared
    /// action counter is spent exactly once (one logical undo/redo = one undo step).
    fn append_inverse_group(&mut self, group: Vec<EditOp>) {
        let action = self.action;
        self.action += 1;
        let tick = self.core.tick;
        let start = self.edit_log.len();
        for op in group {
            self.edit_log.push(EditRecord {
                schema_version: EDIT_SCHEMA_VERSION,
                partition: 0,
                sequence: self.sequence,
                tick,
                action,
                op,
            });
            self.sequence += 1;
        }
        // ONE advance_edits over the whole appended slice (EDITS-FIRST, one tick) so
        // run_log_two_logs regroups it identically on replay (ELOG-02).
        let slice = self.edit_log[start..].to_vec();
        // LIVE capture, strictly BEFORE the fold — an inverse group carries its OWN
        // RemovePort/Configure records (a redo of a remove, an undo of a configure), so
        // this seam needs the capture exactly as much as the forward ones do.
        self.capture_before_fold(&slice);
        let cmds = self.core.advance_edits(&slice, &[]);
        self.retain_effects(cmds);
        // LIVE capture, strictly AFTER the fold — an undo group's re-`Place` /
        // re-`DrawBelt` legs mint, and the NEXT group's inverses must name those ids.
        self.capture_after_fold(&slice);
        self.view.apply_tick(&self.core);
        self.reconstruct_projection();
    }

    /// Fold a batch of ALREADY host-stamped edit records (topology) plus its runtime
    /// `events` through the CERTIFIED [`Core::advance_edits`] VERBATIM, then refresh the
    /// projection — the `&mut self` "fold + project" half that the LIVE host drives at
    /// its tick boundary (Plan 19, decision (c) Option B; RESEARCH Pattern 2). This
    /// mirrors the host's `tick_once` fold step (driver.rs:430-440) so the ONE
    /// GridSession core folds identically to the certified live path.
    ///
    /// Records arrive ALREADY host-stamped (`partition`/`sequence`/`tick`/`action` set
    /// by the host, which owns those counters on the live path). This method does NOT
    /// re-stamp them and does NOT touch `self.sequence` / `self.action` — the
    /// host-stamped values in `edit_log` are authoritative for
    /// [`reconstruct_projection`](Self::reconstruct_projection) and replay.
    ///
    /// In order: (1) `advance_edits(stamped_edits, events)` VERBATIM (EDITS-FIRST,
    /// certified fold untouched), capturing the emitted commands; (2) advance the event
    /// cursor by `events.len()` (mirroring driver.rs:440 — the driver owns the event
    /// cursor); (3) append the host-stamped records to `edit_log`; (4) re-project the
    /// view; (5) `reconstruct_projection` to refresh xlate / cursor / undoable /
    /// can_undo; (6) return the captured commands.
    ///
    /// `events` are folded but NOT mirrored into `self.event_log` — the determinism
    /// proof replays from the persisted redb logs, not GridSession's in-memory copy, so
    /// the in-memory event mirror is not load-bearing on the live path.
    pub fn fold_live(
        &mut self,
        stamped_edits: &[EditRecord],
        events: &[Event],
    ) -> Vec<Command> {
        // (0) LIVE capture, strictly BEFORE the certified fold. This is THE seam the
        //     shipped host drives (driver.rs `tick_once`), so it is where the demo
        //     board's outside-the-log mints stop defeating the undo captures.
        self.capture_before_fold(stamped_edits);
        // (1) The CERTIFIED fold, VERBATIM (EDITS-FIRST). Do NOT modify advance_edits.
        let cmds = self.core.advance_edits(stamped_edits, events);
        // (1b) LIVE capture, strictly AFTER the certified fold (mint harvest + the
        //      running Source-trigger map).
        self.capture_after_fold(stamped_edits);
        // (2) The driver owns the event cursor (mirror driver.rs:440 exactly).
        self.core.cursor += events.len() as u64;
        // (3) The host-stamped records are authoritative — append as-is (no re-stamp).
        self.edit_log.extend_from_slice(stamped_edits);
        // (4) Re-project the view from the just-advanced core (cheap, active-set).
        self.view.apply_tick(&self.core);
        // (5) WR-02: rebuild the undo/redo projection (undoable/cursor/xlate) ONLY when
        //     the edit-log actually changed this tick. `reconstruct_projection` re-folds
        //     the WHOLE persisted edit-log on a throwaway genesis Core — O(history) work.
        //     The projection is a pure function of `self.edit_log`, so an EMPTY-edit tick
        //     leaves it byte-identical; running it every (incl. idle) tick violates the
        //     "idle ticks must be nearly free / active-set only" invariant (README)
        //     and is O(history) per tick / O(history^2) cumulative over a live session.
        //     Undo/redo folds carry non-empty edits (the inverse group), so they still
        //     reconstruct. The full re-fold on `replay`/`recover` is unchanged.
        if !stamped_edits.is_empty() {
            self.reconstruct_projection();
        }
        cmds
    }

    /// Validate → stamp → log → fold → re-project one command under an EXPLICIT
    /// `action` id (the move helper's shared-action primitive). Identical to
    /// [`apply`](Self::apply) except the caller owns the `action` stamping (so a
    /// multi-record action shares one id), and `self.action` is NOT incremented here.
    fn apply_under_action(
        &mut self,
        cmd: GridCommand,
        action: u64,
    ) -> Result<(), CommandError> {
        let mut group = validate_normalize(&self.view.lookup(&self.core), cmd)?;
        // 12-05: same delete-capture enrichment as `apply` — so a move's Delete leg (the
        // ONLY other resolved-Delete producer) captures its cascade subgraph too, making
        // a move of a docked machine undoable in one step. Per RECORD since 72-08, for
        // the same reason `apply` does it per record.
        for record in &mut group {
            self.enrich_delete_capture(record);
            record.tick = self.core.tick;
            record.sequence = self.sequence;
            record.action = action;
            record.partition = 0;
            self.sequence += 1;
        }
        let first = self.edit_log.len();
        self.edit_log.extend(group);
        // LIVE capture, strictly BEFORE the fold (same contract as `apply`).
        let just_pushed: Vec<EditRecord> = self.edit_log[first..].to_vec();
        self.capture_before_fold(&just_pushed);
        let cmds = self.core.advance_edits(&self.edit_log[first..], &[]);
        self.retain_effects(cmds);
        // LIVE capture, strictly AFTER the fold. A move's two legs share ONE action and
        // fold on two ticks, so the harvest APPENDS across them (same shape as the
        // re-fold's `group_placed`).
        self.capture_after_fold(&just_pushed);
        self.view.apply_tick(&self.core);
        self.reconstruct_projection();
        Ok(())
    }

    /// Reconstruct a session PURELY from a persisted edit-log — the SC#3 / UNDO-03
    /// reconstruction primitive (the constructor the save/load test in plan 12-06
    /// needs; `new` is genesis-only and the live-host path does not use `GridSession`).
    ///
    /// Folds `records` from a fresh genesis [`Core`] (the canonical EDITS-FIRST
    /// `run_log_two_logs` fold), restores the provenance high-water marks (so a
    /// resumed session keeps minting monotonic sequence/action ids), re-projects the
    /// view, and rebuilds the `(undoable, cursor, xlate)` projection as a PURE FOLD.
    /// The result is byte-equal — core snapshot hash AND projection — to a live
    /// session that issued the SAME records (UNDO-03).
    ///
    /// A persisted log that passed the load-time trust gate folds within the replay
    /// span; a hostile over-long log makes `run_log_two_logs` refuse (a typed
    /// `ReplayError`, NEVER a panic — threat T-12-04) and leaves the core at genesis,
    /// so the projection reconstructs to an empty-but-valid state.
    #[must_use]
    pub fn replay(seed: u64, records: &[EditRecord]) -> Self {
        let mut core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed,
        });
        // run_log_two_logs is #[must_use]; an Err is a deliberately-refused replay-DoS
        // (a hostile/tampered log). Drop it — the unfolded genesis core then projects
        // to an empty undo/redo stack (panic-free, T-12-04). Legitimate logs are Ok.
        let _ = core.run_log_two_logs(records, &[]);
        let mut view = GridView::new();
        view.apply_tick(&core);
        // High-water marks: the next monotonic ids the resumed session will stamp.
        let sequence = records.iter().map(|r| r.sequence).max().map_or(0, |m| m + 1);
        let action = records.iter().map(|r| r.action).max().map_or(0, |m| m + 1);
        let mut session = Self {
            core,
            edit_log: records.to_vec(),
            event_log: Vec::new(),
            view,
            sequence,
            event_sequence: 0,
            action,
            seed,
            undoable: Vec::new(),
            cursor: 0,
            undo_floor: 0,
            undo_floor_breach: false,
            label_connect_forged: false,
            xlate: BTreeMap::new(),
            original_placed: BTreeMap::new(),
            removed_ports: BTreeMap::new(),
            prior_configs: BTreeMap::new(),
            live_removed_ports: BTreeMap::new(),
            added_port_boxes: BTreeMap::new(),
            live_added_port_boxes: BTreeMap::new(),
            live_prior_configs: BTreeMap::new(),
            live_minted: BTreeMap::new(),
            severed_docks: BTreeMap::new(),
            live_severed_docks: BTreeMap::new(),
            live_severance_split: None,
            live_last_source_trigger: BTreeMap::new(),
            // A REPLAYED session starts with an EMPTY effect buffer. Its fold ran through
            // `Core::run_log_two_logs`, which returns its own `Vec<Command>` to this
            // function and is not one of the retaining seams. That is deliberate and it
            // is not this-phase-or-never: `fabrico-command` is UNFROZEN, so a later phase
            // that wants replay-side effects can retain them here without touching a
            // frozen crate. Nothing in plan 63-09 needs them.
            effects: Vec::new(),
        };
        session.reconstruct_projection();
        session
    }

    /// Reconstruct a session from BOTH persisted logs — the two-log analog of
    /// [`replay`](Self::replay) (the TEST-05 / Pitfall 2 replay-equality primitive).
    /// Folds `edits` (topology) AND `events` (runtime inputs) from a fresh genesis
    /// [`Core`] via the canonical EDITS-FIRST [`run_log_two_logs`], stores BOTH logs,
    /// restores the `sequence`/`action`/`event_sequence` high-water marks, re-projects
    /// the view, and rebuilds the undo/redo projection as a PURE FOLD.
    ///
    /// The result is byte-identical (core snapshot) to a LIVE session that issued the
    /// same `edits` (via [`apply`](Self::apply)) and pumped the same `events` (via
    /// [`pump`](Self::pump)) — the load-bearing two-log replay-equality contract: the
    /// W3 tick-stamps on both logs regroup identically, so the fold reproduces the
    /// exact same `Core` (proven in `tests/pump.rs`). `replay(seed, edits)` is exactly
    /// `replay_two_logs(seed, edits, &[])`.
    ///
    /// A hostile/over-long log makes `run_log_two_logs` refuse with a typed
    /// [`ReplayError`](fabrico_core::core::ReplayError) (NEVER a panic — threat
    /// T-13-02); the authoring path drives author-correct logs, so the dropped `Result`
    /// leaves a genesis core that projects to an empty-but-valid state.
    #[must_use]
    pub fn replay_two_logs(seed: u64, edits: &[EditRecord], events: &[Event]) -> Self {
        let mut core = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed,
        });
        // #[must_use]; an Err is a deliberately-refused replay-DoS (a hostile/tampered
        // log). Drop it — the unfolded genesis core projects to an empty stack (T-13-02).
        let _ = core.run_log_two_logs(edits, events);
        let mut view = GridView::new();
        view.apply_tick(&core);
        // High-water marks: the next monotonic ids a resumed session would stamp. The
        // two logs are on SEPARATE sequence spaces (edits: sequence/action; events:
        // event_sequence).
        // saturating_add: a tampered/forged log can carry sequence/action/event_sequence
        // == u64::MAX; `m + 1` would panic in debug / wrap to 0 in release, contradicting
        // this function's untrusted-replay "NEVER a panic" contract (WR-13-02). At the
        // saturation ceiling the next-id is moot (a >u64::MAX-record log cannot exist).
        let sequence = edits.iter().map(|r| r.sequence).max().map_or(0, |m| m.saturating_add(1));
        let action = edits.iter().map(|r| r.action).max().map_or(0, |m| m.saturating_add(1));
        let event_sequence = events
            .iter()
            .map(|e| e.sequence)
            .max()
            .map_or(0, |m| m.saturating_add(1));
        let mut session = Self {
            core,
            edit_log: edits.to_vec(),
            event_log: events.to_vec(),
            view,
            sequence,
            event_sequence,
            action,
            seed,
            undoable: Vec::new(),
            cursor: 0,
            undo_floor: 0,
            undo_floor_breach: false,
            label_connect_forged: false,
            xlate: BTreeMap::new(),
            original_placed: BTreeMap::new(),
            removed_ports: BTreeMap::new(),
            prior_configs: BTreeMap::new(),
            live_removed_ports: BTreeMap::new(),
            added_port_boxes: BTreeMap::new(),
            live_added_port_boxes: BTreeMap::new(),
            live_prior_configs: BTreeMap::new(),
            live_minted: BTreeMap::new(),
            severed_docks: BTreeMap::new(),
            live_severed_docks: BTreeMap::new(),
            live_severance_split: None,
            live_last_source_trigger: BTreeMap::new(),
            // A REPLAYED session starts with an EMPTY effect buffer. Its fold ran through
            // `Core::run_log_two_logs`, which returns its own `Vec<Command>` to this
            // function and is not one of the retaining seams. That is deliberate and it
            // is not this-phase-or-never: `fabrico-command` is UNFROZEN, so a later phase
            // that wants replay-side effects can retain them here without touching a
            // frozen crate. Nothing in plan 63-09 needs them.
            effects: Vec::new(),
        };
        session.reconstruct_projection();
        session
    }

    /// Rebuild `(undoable, cursor, xlate)` FROM SCRATCH by folding `self.edit_log`
    /// in action-group order (12-RESEARCH Pattern 4, verbatim). This is the proof the
    /// in-memory projection is a pure function of the persisted log: it harvests each
    /// action group's minted ids by re-folding the log on a THROWAWAY genesis core
    /// (slotmap minting is deterministic + seed-independent, so the harvested ids equal
    /// the live ones), then classifies each group by its FIRST record's op.
    ///
    /// # The sentence above is back to its original form (plan 85-09)
    /// Phase 73 widened it to "the persisted log PLUS a persisted second term": a record,
    /// carried in the project file, of nodes the shipped demo minted outside the log, which
    /// this re-fold minted stand-ins for so its allocator kept pace. Plan 85-08 made every
    /// shipped scene log-only and plan 85-09 deleted that record, its file field and the
    /// stand-in step, so the projection is once more a function of the log alone. The
    /// `redo_cursor_equals_fold` proptest pins this sentence.
    ///
    /// Grouping is strictly by contiguous equal `action` (Pitfall 5); a tick never
    /// mixes actions in a `GridSession` log (each `apply` is one record = one tick =
    /// one action; a move spans two ticks under one shared action; an undo/redo group
    /// is many records in ONE tick under one action), so the per-group tick-by-tick
    /// fold below accumulates exactly that group's minted ids.
    ///
    /// # The FOUR live-authoritative overrides, and exactly who is exempt
    /// The throwaway re-fold can only see nodes MINTED BY THE EDIT LOG, so on a session
    /// whose core holds nodes the log never minted (a core built by hand through
    /// `core_mut`, or a hand-edited file whose board and log disagree) its
    /// `removed_ports` / `prior_configs` capture MISSES and its minted-id harvest names
    /// nodes several allocator slots too early. FOUR live maps —
    /// [`live_removed_ports`](Self::live_removed_ports),
    /// [`live_prior_configs`](Self::live_prior_configs),
    /// [`live_minted`](Self::live_minted) and, since 67-03,
    /// [`live_severed_docks`](Self::live_severed_docks) — are recorded against the REAL
    /// core at fold time and WIN over the re-fold harvest here. The first two are merged
    /// per key at the tail of this function; the last two are merged PER ACTION inside
    /// the walk, for the reason written at each of those two merge sites.
    ///
    /// The EXEMPT set (where all FOUR live maps stay empty, so this projection is
    /// byte-identical to the pre-fix behaviour, which is what keeps the SC#3
    /// reconstruction tests and the `redo_cursor_equals_fold` proptest honest) is
    /// precisely: [`replay`](Self::replay) / [`replay_two_logs`](Self::replay_two_logs)
    /// (pure log projection, no live fold) and a [`new`](Self::new) session that is
    /// never `apply`-ed. A `new` session FOLLOWED BY `apply` DOES fold live and DOES
    /// populate the maps — that is the FIXED path, not an exempt one, and the unit
    /// tests in this crate exercise it.
    ///
    /// The exempt set is exactly where [`severed_docks`](Self::severed_docks) EARNS its
    /// re-fold harvest: a session rebuilt by `replay` from a saved edit-log never folds
    /// live, so its live twin is empty by construction and the compensating `Dock`
    /// records for a severing `Rotate` can come from nowhere else. The
    /// `the_compensation_survives_a_save_and_a_load` leg in
    /// `crates/fabrico-command/tests/rotate_undo_redock.rs` is the only thing that can
    /// see that half fail.
    fn reconstruct_projection(&mut self) {
        let mut undoable: Vec<u64> = Vec::new();
        let mut cursor: usize = 0;
        // Plan 85-06 (D-10): the undo floor, set by the seal arm below to the cursor at the
        // LAST seal in the log (`0` when there is none), and whether any undo record
        // reached below it (a forged log only; see `undo_floor_breach`).
        let mut undo_floor: usize = 0;
        let mut undo_floor_breach = false;
        // Plan 86-07 (D-08): whether any slice's fold refused a label connect.
        let mut label_connect_forged = false;
        let mut xlate: BTreeMap<NodeId, NodeId> = BTreeMap::new();
        // The original-minted ids per NORMAL action — used to positionally refresh
        // `xlate` when a later Redo group re-mints that action's nodes under new ids.
        let mut original_placed: BTreeMap<u64, Vec<NodeId>> = BTreeMap::new();
        // PORT-07 undo-capture: the port each RemovePort removed, keyed by its
        // (action, sequence). Rebuilt purely from the log (never serialized) so undo of
        // a remove survives save/load — see the `removed_ports` field doc.
        let mut removed_ports: BTreeMap<(u64, u64), (Port, PortId)> = BTreeMap::new();
        // 74.1-16 undo-capture (the `removed_ports` analog): the box and anchor each AddPort
        // grew from, keyed by (action, sequence). See the `added_port_boxes` field doc.
        let mut added_port_boxes: BTreeMap<(u64, u64), BoxRestore> = BTreeMap::new();
        // CFG-02 undo-capture (the `removed_ports` analog): the PRIOR effective config
        // each Configure overwrote, keyed by (action, sequence). Also rebuilt purely from
        // the log — see the `prior_configs` field doc.
        let mut prior_configs: BTreeMap<(u64, u64), MachineConfig> = BTreeMap::new();
        // CONNECT-03 / SEED-006 undo-capture (the `removed_ports` analog, with ONE shape
        // difference stated at its harvest below): the docks each Rotate SEVERED, keyed
        // by (action, sequence). Also rebuilt purely from the log — see the
        // `severed_docks` field doc.
        let mut severed_docks: BTreeMap<(u64, u64), Vec<UnlinkedDock>> = BTreeMap::new();
        // The running effective Source trigger per node during this re-fold walk. A Source
        // config is a CORE no-op (never in state), so the prior trigger cannot be read
        // from `fresh` — it is tracked here across ALL Configure{Source} records (forward
        // AND the inverse Configures an undo appends), so it always reflects the trigger
        // effective just before the next Configure folds (default Webhook when unset).
        let mut last_source_trigger: BTreeMap<NodeId, SourceTrigger> = BTreeMap::new();

        let mut fresh = Core::genesis(LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: self.seed,
        });
        let records = &self.edit_log;
        let mut i = 0usize;
        while i < records.len() {
            let action = records[i].action;
            // Contiguous equal-action group (Pitfall 5: group strictly by `action`).
            let mut j = i;
            while j < records.len() && records[j].action == action {
                j += 1;
            }
            // Fold the group tick-by-tick on the throwaway core, accumulating the ids
            // it mints (the group's `last_tick.placed`, summed across its ticks).
            let mut group_placed: Vec<NodeId> = Vec::new();
            let mut k = i;
            while k < j {
                let tick = records[k].tick;
                let tstart = k;
                while k < j && records[k].tick == tick {
                    k += 1;
                }
                // PORT-07 / 74.1-16 / 73-12 / CFG-02: the slice's undo captures, read
                // off the fresh core BEFORE the slice folds, through the SAME helper
                // `capture_before_fold` calls on the real core, so an undo behaves the
                // same before and after a save. A `GridSession::apply` log folds one
                // record per tick, so there the pre-slice read IS the pre-record read;
                // a `fold_live` drain pass can stamp several port edits on one node
                // into one tick, and for that slice the helper captures record by
                // record (plan 74.1-23, review WR-01). See `capture_slice`.
                let captured = capture_slice(&fresh, &records[tstart..k], &last_source_trigger);
                // Phase 89: the per-record severances of a slice that names one node in two
                // severing records, read off `fresh` BEFORE the slice folds (see
                // `attribute_severances`). A BACKSTOP here, not a need: this loop already
                // slices by action before tick, so a paused R then Shift+R (two actions in one
                // live tick) folds as two slices and node-keyed attribution is exact in each.
                // Only one action naming one node in two severing records in one tick would
                // reach the split, and no producer emits that shape today (review IN-A-01).
                let split = severances_need_split(&records[tstart..k])
                    .then(|| split_severances(&fresh, &records[tstart..k]));
                for (key, boxed) in captured.added_port_boxes {
                    added_port_boxes.insert(key, boxed);
                }
                for (key, removed) in captured.removed_ports {
                    removed_ports.insert(key, removed);
                }
                for (key, prior) in captured.prior_configs {
                    prior_configs.insert(key, prior);
                }
                fresh.advance_edits(&records[tstart..k], &[]);
                // Plan 86-07 (D-08): a connect fold met a label and changed nothing. Read off
                // the slice's own observation, the `group_placed` surface below.
                if !fresh.last_tick.refused_label_connects.is_empty() {
                    label_connect_forged = true;
                }
                // Update the running Source-trigger map AFTER the slice folds (so the NEXT
                // Configure's prior read sees this one's effect). Forward AND inverse
                // Configure{Source} records both flow here, so an undo's restore is tracked.
                for r in &records[tstart..k] {
                    if let EditOp::Configure {
                        node,
                        config: MachineConfig::Source { trigger },
                        ..
                    } = &r.op
                    {
                        last_source_trigger.insert(*node, trigger.clone());
                    }
                }
                group_placed.extend(fresh.last_tick.placed.iter().copied());
                // CONNECT-03 / SEED-006: the reconstruct-time TWIN of
                // `capture_after_fold`'s severed-dock harvest. Read POST-fold, not
                // pre-fold, and that is the ONE shape difference from its two siblings
                // twenty lines up: a removed port and a prior config are PRIOR STATES
                // (readable only before the fold destroys them), while a severance is a
                // CONSEQUENCE the fold produces, so there is nothing to read until the
                // slice has folded. It sits in the same line-neighbourhood as, and reads
                // the same `last_tick` surface as, the `group_placed` harvest above.
                //
                // Attribution is by `UnlinkedDock.node` against this slice's Rotate
                // records — the SAME node-keyed rule the live capture uses, never
                // positional. See `capture_after_fold`'s "Severed-dock attribution"
                // docblock for why the mint harvest's `mint_idx` stepping cannot be
                // reused: a Rotate emits a VARIABLE number of records.
                //
                // WITHOUT THIS HARVEST the undo of a severing Rotate emits nothing after
                // a save and a load — correct in every live session, correct in the live
                // e2e oracle, silently broken from disk (Finding 7, threat T-67-03-04).
                // That is why it carries its own test leg and its own mutation proof.
                //
                // ONE RULE, ONE FUNCTION (67-REVIEW WR-04). This harvest and the live one
                // in `capture_after_fold` used to be two hand-maintained copies of the
                // same node-keyed attribution, and only the live copy carried the A3
                // check — backwards relative to the risk, because THIS half is the
                // authoritative one on the load path and `GridSession::replay` is a `pub`
                // primitive a hand-edited or forged log reaches. They are now the SAME
                // call, so they cannot drift and the check covers both.
                for (key, mine) in
                    attribute_severances(&records[tstart..k], &fresh.last_tick.unlinked, split)
                {
                    severed_docks.insert(key, mine);
                }
            }
            // LIVE-WINS, PER ACTION, INSIDE the walk (never a post-walk merge): `xlate`
            // is built DURING this walk, so the classification arms below must already
            // see live ids. The throwaway `fresh` allocator runs behind the live one by
            // exactly the number of nodes the edit log never minted, so `group_placed`
            // names real-but-WRONG nodes on such a board, which is how an Undo of a Place
            // on the shipped demo of the time (its request pair then minted outside the
            // log) came to emit a `Delete` against one of that pair's cables while leaving
            // the placed machine standing. `live_minted` is harvested from the REAL `last_tick.placed`, so
            // it is correct by construction. An action with no live entry (the pure-load
            // path) falls back to the re-fold harvest unchanged.
            let group_placed = self
                .live_minted
                .get(&action)
                .cloned()
                .unwrap_or(group_placed);
            // CONNECT-03 / SEED-006: the severed-dock live-wins merge, PER ACTION and
            // INSIDE the walk.
            //
            // WHICH PRECEDENT WAS TAKEN, AND WHY. This follows `live_minted` (the line
            // directly above), NOT `removed_ports`' post-walk per-key merge at the tail of
            // this function. The two captures are harvested from different surfaces and
            // that is what decides it: `removed_ports` and `prior_configs` are read from
            // `fresh.state` BEFORE a fold, so a re-fold entry for a given record is either
            // right or absent, and layering the live map over it per key is exact. The
            // severed set, like `placed`, is harvested from `last_tick` AFTER a fold, on a
            // throwaway core whose allocator runs behind the live one by exactly the
            // number of nodes the edit log never minted. On such a board the re-fold's `Rotate`
            // lands on a real-but-WRONG node, so it can invent a severance the live fold
            // never had — under a key the live map therefore has no entry for. A per-key
            // post-walk merge would RESURRECT that invention (nothing overwrites a key
            // live never wrote) and the undo would emit a `Dock` naming ids the live core
            // does not hold. Replacing the whole ACTION when the live map speaks for it
            // is what drops those inventions. An action with no live entry — the pure-load
            // path — falls back to the re-fold harvest unchanged, which is exactly the
            // save/load case this capture exists for.
            let live_for_action: Vec<((u64, u64), Vec<UnlinkedDock>)> = self
                .live_severed_docks
                .range((action, 0)..=(action, u64::MAX))
                .map(|(k, v)| (*k, v.clone()))
                .collect();
            if !live_for_action.is_empty() {
                severed_docks.retain(|k, _| k.0 != action);
                for (key, docks) in live_for_action {
                    severed_docks.insert(key, docks);
                }
            }
            // Classify the group by its FIRST record (the lineage marker, if any).
            match &records[i].op {
                // UNDO marker: the group's records physically reversed `target`'s
                // effect, so the projection moves EXACTLY THAT ACTION out of the live
                // part of the stack (plan 74.1-23, GAP N3-RACE).
                //
                // WHY IT MOVES THE NAMED ACTION, NOT "THE TOP". An Undo resolved against
                // a stale projection (the old host drained a Dock and a Ctrl+Z in one
                // pass) names the action BELOW a same-tick forward edit. Stepping the
                // cursor back by one regardless moved that forward edit (the Dock) into
                // the redo tail while the named action stayed "live"; every later Undo
                // then targeted the already-deleted belt's DrawBelt, the target-identity
                // guard refused it, and the user saw `Malformed` forever. Moving the named
                // action to the boundary and stepping back over it keeps the projection
                // equal to what the core holds. When the marker names the top (every log
                // this build writes) the move is the identity and this is the old step.
                //
                // A marker the projection cannot place (its target is not live) keeps the
                // old saturating step, so the cursor never goes below 0 (threat T-12-04:
                // bounded cursor arithmetic).
                EditOp::Undo { target_action } => {
                    match undoable[..cursor].iter().position(|a| a == target_action) {
                        Some(p) => {
                            // Plan 85-06 (T-85-14): a marker naming an action UNDER the
                            // floor undoes a sealed scene command. No log this build writes
                            // holds one (Undo is refused at the floor), so it is recorded
                            // as a breach and `load_project` refuses the file. The walk
                            // itself goes on unchanged, so the projection stays a total
                            // function of any log.
                            if p < undo_floor {
                                undo_floor_breach = true;
                            }
                            let named = undoable.remove(p);
                            undoable.insert(cursor - 1, named);
                            cursor -= 1;
                        }
                        None => cursor = cursor.saturating_sub(1),
                    }
                    // 12-05: a Delete-undo group RE-MINTS the machine + every cascade
                    // belt; refresh `xlate` so a later inverse naming the deleted machine
                    // (a redo of the delete re-Deletes `live(machine)`, whose cascade then
                    // re-removes the restored belts) retargets to the restoration
                    // (Pitfall 1). `group_placed` is [machine, belts…] in capture order —
                    // the SAME order the undo group's Place→(Wire|DrawBelt) records mint.
                    if let Some(EditOp::Delete { node, captured, .. }) = records
                        .iter()
                        .find(|r| {
                            r.action == *target_action && matches!(r.op, EditOp::Delete { .. })
                        })
                        .map(|r| &r.op)
                        && let Some(&machine_new) = group_placed.first()
                    {
                        xlate.insert(*node, machine_new);
                        // Plan 88-02 (WINDOWS 228, D-04): pair each captured belt with the id
                        // ITS re-draw minted, through the one walk `compute_inverse` writes the
                        // group with (an empty-geometry capture is skipped and takes no id).
                        // Until then this paired by position over every captured belt.
                        let mut minted_belts = group_placed.iter().skip(1).copied();
                        // The closure never refuses, so the walk never errs here.
                        let pairs = pair_captured_belts_with_minted(&captured.belts, |_| {
                            Ok(minted_belts.next())
                        })
                        .unwrap_or_default();
                        for (belt, belt_new) in pairs {
                            // 74-03 (T-74-14): SKIP a record whose links name no belt.
                            // This rebuild has no Result to refuse through, and the old
                            // fallback answered `machine` - which wrote the belt's fresh id
                            // over the entry naming the re-minted MACHINE, one line after
                            // it was written. Inserting nothing leaves the machine's entry
                            // honest; `compute_inverse` is where the same capture earns its
                            // typed refusal.
                            if let Some(belt_orig) = identify_belt(&belt.links, *node) {
                                xlate.insert(belt_orig, belt_new);
                            }
                        }
                    }
                }
                // REDO marker: the group re-applied `target`, so the projection moves
                // EXACTLY THAT ACTION into the live part of the stack (plan 74.1-23, the
                // mirror of the Undo arm above and for the same reason):
                // - named and next: step forward (every log this build writes);
                // - named, undone, but not next: move it to the boundary, step over it;
                // - named but CUT from the stack by a same-tick forward edit that folded
                //   first (the edit truncated the redo tail, then the Redo re-applied the
                //   action anyway): push it on top as live, step over it. Only a NORMAL
                //   action this walk has seen (`original_placed` holds every one) is
                //   pushed, so a forged marker naming no action cannot invent one;
                // - anything else (already live, or unknown): the old clamped step,
                //   never past the stack.
                // Then refresh `xlate` positionally: target's original-minted ids -> this
                // group's freshly re-minted ids (Pitfall 1 — cross-undo/redo id remap).
                EditOp::Redo { target_action } => {
                    let undone = undoable[cursor..].iter().position(|a| a == target_action);
                    if let Some(p) = undone {
                        let named = undoable.remove(cursor + p);
                        undoable.insert(cursor, named);
                        cursor += 1;
                    } else if !undoable.contains(target_action)
                        && original_placed.contains_key(target_action)
                    {
                        undoable.insert(cursor, *target_action);
                        cursor += 1;
                    } else {
                        cursor = (cursor + 1).min(undoable.len());
                    }
                    if let Some(orig) = original_placed.get(target_action) {
                        for (original, new) in orig.iter().zip(group_placed.iter()) {
                            xlate.insert(*original, *new);
                        }
                    }
                }
                // HISTORY SEAL (85-05, D-10, Pitfall 2): a group opened by the seal is
                // NEVER an undoable action. It neither pushes onto `undoable` nor
                // truncates the redo tail, and it mints nothing, so `xlate` and
                // `original_placed` are untouched too. Without this arm the seal would
                // fall into the normal-group arm below and become an undoable action, so
                // the first Ctrl+Z after a scene load would "undo" a record that changes
                // nothing and the second would start dismantling the scene.
                //
                // THE UNDO FLOOR (plan 85-06, DEMO-05): the floor becomes the cursor. Every
                // action live at the seal (a seeded scene's commands) is now below it, so
                // `can_undo` is false and Undo answers `NothingToUndo` until the user makes
                // an edit of their own. A later seal moves the floor up to its own cursor;
                // the last one wins. Read here and nowhere else, so the live fold, a replay
                // and a reopened file compute the same floor from the same record.
                EditOp::SealHistory => {
                    undo_floor = cursor;
                }
                // NORMAL group (no marker): a fresh action AFTER an undo kills the
                // redo tail (Q1.1 linear history), then pushes + advances the cursor
                // and seeds identity `xlate` entries for its minted ids.
                _ => {
                    if cursor < undoable.len() {
                        undoable.truncate(cursor);
                    }
                    undoable.push(action);
                    cursor += 1;
                    for id in &group_placed {
                        xlate.insert(*id, *id);
                    }
                    original_placed.insert(action, group_placed.clone());
                }
            }
            // Plan 85-06 (T-85-14): the cursor below the floor at ANY point of the walk is
            // a breach, even if a later Redo climbs back above it.
            if cursor < undo_floor {
                undo_floor_breach = true;
            }
            i = j;
        }

        self.undoable = undoable;
        self.cursor = cursor;
        self.undo_floor = undo_floor;
        self.undo_floor_breach = undo_floor_breach;
        self.label_connect_forged = label_connect_forged;
        self.xlate = xlate;
        self.original_placed = original_placed;
        // LIVE-WINS merge. The throwaway re-fold above can only see nodes minted BY THE
        // EDIT LOG; a live session whose core holds nodes the log never minted (a core
        // built by hand, a hand-edited file) has `fresh.state.ports_of(LIVE_id)` miss
        // entirely. Every shipped scene is log-only, so on them the two agree. So the re-fold harvest is a BEST-EFFORT reconstruction while the
        // live read (taken against the very core the record folded into) is authoritative
        // BY CONSTRUCTION. Start from the re-fold, then let every live entry overwrite —
        // the re-fold therefore fills ONLY the keys the live map lacks, which is exactly
        // the pure-load path (`replay` / `replay_two_logs` never populate the live map,
        // so their projection is byte-identical to the pre-fix behaviour).
        let mut merged_removed_ports = removed_ports;
        for (key, entry) in &self.live_removed_ports {
            merged_removed_ports.insert(*key, *entry);
        }
        self.removed_ports = merged_removed_ports;
        // Same live-wins merge for the 74.1-16 add-box capture (identical rationale).
        let mut merged_added_port_boxes = added_port_boxes;
        for (key, entry) in &self.live_added_port_boxes {
            merged_added_port_boxes.insert(*key, *entry);
        }
        self.added_port_boxes = merged_added_port_boxes;
        // Same live-wins merge for the CFG-02 capture (identical rationale).
        let mut merged_prior_configs = prior_configs;
        for (key, config) in &self.live_prior_configs {
            merged_prior_configs.insert(*key, config.clone());
        }
        self.prior_configs = merged_prior_configs;
        // 86-03 (WORK-01, D-01, research Pitfall 1, MEASURED red on a real host by
        // `crates/fabrico-host/tests/delete_undo_config_host.rs`): seed the LIVE running
        // Source-trigger map from the re-fold's, the live entry winning where both exist
        // (the same live-wins rule as the merges above). After a load the session is
        // rebuilt by `replay_two_logs`, which never folds live, so the live map started
        // empty; the next live capture (a Delete of a Timer Source, or a Configure of it)
        // then read Webhook, wrote that into `live_prior_configs`, and the live-wins merge
        // above let it overwrite the Timer the re-fold had read off the log. The undo then
        // gave back a webhook source. Seeded here, the live capture after a load reads the
        // Timer the log holds. Before any load the two maps already agree on every node the
        // log minted, so this changes nothing there.
        for (node, trigger) in last_source_trigger {
            self.live_last_source_trigger.entry(node).or_insert(trigger);
        }
        // CONNECT-03 / SEED-006. NO merge here on purpose: the severed-dock capture was
        // already merged live-wins PER ACTION inside the walk above, following
        // `live_minted` rather than the two post-walk merges directly overhead. The
        // reason that choice is not cosmetic is written at the merge site.
        self.severed_docks = severed_docks;
    }

    /// Whether an undo is available: the cursor is above the UNDO FLOOR
    /// (`cursor > undo_floor`).
    ///
    /// The floor (plan 85-06, D-10, DEMO-05) is the cursor at the last logged
    /// [`EditOp::SealHistory`], which `seed_scene` writes after a scene's last command. A
    /// freshly loaded demo or example therefore has nothing to undo, where it used to
    /// have every one of the scene's own commands (walk-112: each Ctrl+Z unplugged one of
    /// the scene's docks). A log with no seal has floor 0, which is the old
    /// `cursor > 0`: a user's own board and a reopened `.fab` keep every action the user
    /// made (UNDO-07).
    #[must_use]
    pub fn can_undo(&self) -> bool {
        self.cursor > self.undo_floor
    }

    /// Whether a redo is available — the cursor is behind the stack top
    /// (`cursor < undoable.len()`, i.e. there is an undone action to re-apply).
    #[must_use]
    pub fn can_redo(&self) -> bool {
        self.cursor < self.undoable.len()
    }

    /// The undoable-action stack (a pure projection of the edit-log): the live
    /// actions followed by the undone/redoable tail. Exposed so the `redo_cursor_
    /// equals_fold` proptest can assert the live projection equals a fresh `replay`.
    #[must_use]
    pub fn undoable_stack(&self) -> &[u64] {
        &self.undoable
    }

    /// The linear redo cursor (count of currently-live actions; the tail
    /// `cursor..undoable_stack().len()` is undone/redoable).
    #[must_use]
    pub fn redo_cursor(&self) -> usize {
        self.cursor
    }

    /// The undo floor (plan 85-06, D-10): the cursor at the last logged
    /// [`EditOp::SealHistory`], `0` when the log holds none. Undo is available only while
    /// [`redo_cursor`](Self::redo_cursor) is above it. A pure projection of the log, so
    /// the `redo_cursor_equals_fold` proptest compares it with a fresh fold.
    #[must_use]
    pub fn undo_floor(&self) -> usize {
        self.undo_floor
    }

    /// Whether this log's undo history reaches below its undo floor (plan 85-06, D-10,
    /// T-85-14): an Undo marker naming an action under the floor, or the cursor below the
    /// floor anywhere in the log (which includes a floor left above the final cursor).
    /// Never true for a log this build writes, because Undo is refused at the floor; a
    /// `.fab` that holds one was edited by hand or damaged, and `load_project` refuses it
    /// with `ProjectError::UndoFloorBreached` rather than open a board whose scene
    /// commands were undone behind the floor.
    #[must_use]
    pub fn undo_floor_breached(&self) -> bool {
        self.undo_floor_breach || self.undo_floor > self.cursor
    }

    /// Whether this log holds a record joining a label to a port, a belt or a cable (plan
    /// 86-07, D-08, WORK-09). Never true for a log this build writes, because every such
    /// gesture is refused as `LabelDoesNotConnect`; a `.fab` that holds one was edited by
    /// hand or damaged, and `load_project` refuses it with `ProjectError::LabelConnected`
    /// rather than drop the record and open the board.
    #[must_use]
    pub fn label_connect_forged(&self) -> bool {
        self.label_connect_forged
    }

    /// The original->current `NodeId` translation map (deterministic `BTreeMap`).
    #[must_use]
    pub fn id_translation(&self) -> &BTreeMap<NodeId, NodeId> {
        &self.xlate
    }

    /// The action id an undo would target (the top live action, `undoable[cursor-1]`),
    /// or `None` when nothing is undoable. Consumed by [`undo`](Self::undo) and
    /// [`resolve_undo`](Self::resolve_undo), which both answer `None` with
    /// [`NothingToUndo`](CommandError::NothingToUndo).
    ///
    /// `None` at or below the UNDO FLOOR (plan 85-06, D-10): the actions there are a
    /// seeded scene's own commands, sealed by `seed_scene`, and undoing one would take
    /// the shipped scene apart. Checking the floor HERE, the one function both undo paths
    /// resolve through, is what makes the headless driver and the live host refuse alike.
    fn undo_target(&self) -> Option<u64> {
        if self.cursor <= self.undo_floor {
            return None;
        }
        self.cursor.checked_sub(1).map(|i| self.undoable[i])
    }

    /// The action id a redo would target (the next undone action, `undoable[cursor]`),
    /// or `None` when nothing is redoable. Consumed by [`redo`](Self::redo).
    fn redo_target(&self) -> Option<u64> {
        self.undoable.get(self.cursor).copied()
    }

    /// The append-only edit-log of RESOLVED records (the ELOG-02 replay source).
    #[must_use]
    pub fn edit_log(&self) -> &[EditRecord] {
        &self.edit_log
    }

    /// The deterministic core reflecting the folded topology.
    #[must_use]
    pub fn core(&self) -> &Core {
        &self.core
    }

    /// Mutable access to the deterministic core — the host's `Host::core_mut()`
    /// demo/test backdoor (Plan 02) mirror of [`core`](Self::core).
    ///
    /// WARNING: this BYPASSES `edit_log` / `view` / the undo-redo projection. It
    /// exists only for demo/test scaffolding that pokes the core directly; PRODUCTION
    /// topology writes MUST go through [`fold_live`](Self::fold_live) (host-stamped,
    /// certified fold) so the edit-log stays the authoritative replay source and the
    /// projection stays a pure function of it.
    pub fn core_mut(&mut self) -> &mut Core {
        &mut self.core
    }

    /// The read-only grid projection (occupancy + handle resolution).
    #[must_use]
    pub fn view(&self) -> &GridView {
        &self.view
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fabrico_core::belt_slots::DEFAULT_TICKS_PER_SLOT;
    use fabrico_core::core::Core;
    use fabrico_core::edit::{EditOp, EditRecord};
    use fabrico_core::event::{LogHeader, SCHEMA_VERSION};
    use fabrico_core::ids::NodeId;
    use fabrico_core::snapshot::snapshot;
    use fabrico_core::tick::DEFAULT_ARITY;

    /// Every PLACEABLE kind the catalog resolves: the ONE list, so a new arm cannot be
    /// added to `port_catalog` and forgotten by the covering tests. `BELT` is absent
    /// deliberately: it has a portless arm only so the tree stays build-green and
    /// `Place{BELT}` is a typed reject (17-02), so every port-shaped assertion over it
    /// would pass vacuously and hide nothing.
    const CATALOG_KINDS: [u8; 10] = [
        machine_kind::SOURCE,
        machine_kind::FACTORY,
        machine_kind::TEE,
        machine_kind::BALANCER,
        machine_kind::ROUTER,
        machine_kind::MERGE,
        machine_kind::SINK,
        machine_kind::ENDPOINT,
        // 72-05: HANDLER joins the covering list on the commit that gives it an arm,
        // which is the whole point of there being ONE list. Note that it is the one
        // entry `fold_place` cannot yet MINT - see
        // `base_footprint_equals_port_catalog_for_every_operator_kind`, the only test
        // below that places through the fold, and the tripwire that closes the gap.
        machine_kind::HANDLER,
        // Phase 76: LABEL joins on the commit that gives it a catalog arm AND a fold arm,
        // so every sweep below (ports In-first, ports on their face, ports inside the box,
        // the W1 base parity, the ghost entry) covers it. Its port list is empty, so the
        // port sweeps hold over nothing for it, and the box sweeps are what it adds.
        machine_kind::LABEL,
    ];

    /// Count ports of a given role in a resolved catalog entry.
    fn count_role(ports: &[Port], role: Role) -> u16 {
        u16::try_from(ports.iter().filter(|p| p.role == role).count()).unwrap()
    }

    #[test]
    fn port_catalog_factory_is_3x3_with_fault_at_index_2_s_center() {
        let (foot, ports) = port_catalog(machine_kind::FACTORY);
        assert_eq!(foot, Footprint { w: 3, h: 3, rot: 0 });
        assert_eq!(ports.len(), 3, "FACTORY has In + Out + Fault");
        assert_eq!(
            ports[0],
            Port { local_offset: (0, 1), side: Side::W, role: Role::In, medium: Medium::Mechanical },
        );
        assert_eq!(
            ports[1],
            Port { local_offset: (2, 1), side: Side::E, role: Role::Out, medium: Medium::Mechanical },
        );
        // Locked: Fault is the THIRD entry (array index 2, S-center) so it sorts LAST.
        assert_eq!(
            ports[2],
            Port { local_offset: (1, 2), side: Side::S, role: Role::Fault, medium: Medium::Mechanical },
        );
        assert_eq!(ports[2].role, Role::Fault, "index 2 is the Fault role");
    }

    #[test]
    fn port_catalog_every_kind_lists_in_ports_first() {
        // 20-review WR-02: the "In ports come FIRST in every catalog entry"
        // invariant is LOAD-BEARING in two crates but was asserted nowhere. The
        // Dock arm's forward link-key translation only converts Tail/Out keys on
        // the ground that Head/In keys are already aligned with the catalog index,
        // and `dock_still_reaches` (state.rs) resolves a Head link key as a raw
        // catalog index. A future catalog entry declaring an Out (or Fault) port
        // BEFORE an In port would silently mis-key every Head dock into the wrong
        // inbox AND make the rotate keep-or-unlink predicate judge the wrong nub —
        // the silent-item-vanish class the Out-side translation fixed. Pin the
        // ordering for EVERY placeable kind (`CATALOG_KINDS`), which is also what stops
        // a newly-added catalog arm escaping this sweep.
        for kind in CATALOG_KINDS {
            let (_, ports) = port_catalog(kind);
            let first_non_in = ports
                .iter()
                .position(|p| p.role != Role::In)
                .unwrap_or(ports.len());
            assert!(
                ports[first_non_in..].iter().all(|p| p.role != Role::In),
                "kind {kind}: every Role::In port must precede all non-In ports \
                 (Head dock key == catalog index — the invariant the forward \
                 translation and dock_still_reaches both lean on)"
            );
        }
    }

    #[test]
    fn port_catalog_ports_sit_on_the_face_their_side_names() {
        // 72-15: THE HALF-PLANE LEMMA THE WIRE AUTO-ROUTER'S BODY AVOIDANCE RESTS ON,
        // turned from an unenforced convention into a gate.
        //
        // `wire_route::face_aligned_cells` leaves along the source port's outward normal
        // and arrives against the target's, and the ONLY reason that keeps a cable off a
        // machine's body is this: `side` names the face the nub is drawn on, so the port
        // cell sits at the footprint's extreme along that normal and the whole body lies
        // behind it. Honour the face and no emitted cell but the endpoint itself is inside
        // that machine.
        //
        // Nothing enforced it. A future catalog arm declaring, say, a W-facing port at
        // local x == 1 of a 3x3 would silently degrade the router back to drawing across
        // bodies, and NO test would go red: the corpus would simply freeze the worse
        // shape and assert it forever. That is the checks-that-cannot-fail class this
        // phase has already met twice, so it is closed here rather than described.
        //
        // Local offsets are pre-rotation; `port_world` rotates offset and side together,
        // so pinning the unrotated catalog is sufficient.
        for kind in CATALOG_KINDS {
            let (fp, ports) = port_catalog(kind);
            for (i, p) in ports.iter().enumerate() {
                let (x, y) = p.local_offset;
                let (ok, face) = match p.side {
                    Side::N => (y == 0, "N -> y == 0"),
                    Side::S => (y == i32::from(fp.h) - 1, "S -> y == h-1"),
                    Side::W => (x == 0, "W -> x == 0"),
                    Side::E => (x == i32::from(fp.w) - 1, "E -> x == w-1"),
                };
                assert!(
                    ok,
                    "kind {kind} port {i}: local_offset {:?} is not on the face its side \
                     names ({face}) for footprint {}x{}. The wire auto-router's \
                     body-avoidance guarantee (wire_route.rs::face_aligned_cells) is \
                     exactly this property; a port off its own face silently degrades \
                     every cable docked to it back to drawing across the chassis.",
                    p.local_offset,
                    fp.w,
                    fp.h,
                );
            }
        }
    }

    #[test]
    fn port_catalog_router_2x3_seats_the_reseat_rules_layout() {
        // RETITLED AND MOVED IN 74.1-14 (was `port_catalog_router_2x3_exemplar_byte_stable`).
        // The "Edits keep middle layout" decision (2026-10-04): the Router catalog
        // takes the port-edit reseat rule's output, so its first port edit moves no nub.
        // The In moves from (0,0) to the middle row (0,1) and the Outs from rows 2, 0, 1
        // to rows 1, 2, 0; the Fault stays at S@(0,2). The INDICES are unchanged (In 0,
        // Outs 1..=ROUTER_OUT_ARITY, Fault last), so no dock key changes meaning; the
        // boards that docked the old CELLS were re-authored in the same plan. The
        // footprint is still the frozen 2x3, and these offsets are literals, compared
        // here and in `reseat_catalog_layout.rs` to the rule, never derived from it.
        let (foot, ports) = port_catalog(machine_kind::ROUTER);
        assert_eq!(foot, Footprint { w: 2, h: 3, rot: 0 });
        assert_eq!(
            ports,
            vec![
                Port { local_offset: (0, 1), side: Side::W, role: Role::In, medium: Medium::Mechanical },
                Port { local_offset: (1, 1), side: Side::E, role: Role::Out, medium: Medium::Mechanical },
                Port { local_offset: (1, 2), side: Side::E, role: Role::Out, medium: Medium::Mechanical },
                Port { local_offset: (1, 0), side: Side::E, role: Role::Out, medium: Medium::Mechanical },
                Port { local_offset: (0, 2), side: Side::S, role: Role::Fault, medium: Medium::Mechanical },
            ],
        );
    }

    #[test]
    fn port_catalog_router_out_arity_comes_from_the_one_shared_constant() {
        // ROUTE-02. Phase 65's rules editor imports THIS symbol, so the assertion here
        // is the EQUALITY and never a restated literal (Phase 65 SC2). If the two halves
        // ever disagree it is because someone wrote the number twice, which is the
        // failure this test exists to make impossible.
        let (_, ports) = port_catalog(machine_kind::ROUTER);
        assert_eq!(count_role(&ports, Role::In), 1, "ROUTER has exactly 1 In");
        assert_eq!(
            count_role(&ports, Role::Out),
            ROUTER_OUT_ARITY,
            "ROUTER's Out arity IS ROUTER_OUT_ARITY (one shared source)",
        );
        // `2 +` since phase 71 (PILE-10): the In, the Outs, and the appended Fault nub.
        // The Out COUNT above is untouched and is still the shared constant - the fault
        // port is a third role and is deliberately not folded into the arity.
        assert_eq!(count_role(&ports, Role::Fault), 1, "ROUTER has exactly 1 Fault");
        assert_eq!(
            ports.len(),
            2 + ROUTER_OUT_ARITY as usize,
            "the ROUTER catalog is exactly its In, ROUTER_OUT_ARITY Outs, and its Fault",
        );
    }

    #[test]
    fn port_catalog_router_keeps_in_first_outs_next_and_fault_last() {
        // RETITLED IN 74.1-14 (was `port_catalog_router_widening_appended_and_shifted_no_
        // existing_index`). T-63-56: a `PortId` is an INDEX into this Vec, so the index
        // ORDER is what a dock key means. That property survives the 74.1-14 cell move
        // unchanged and is what this test still pins: the In at index 0 (a Head dock key
        // is a raw catalog index), the ROUTER_OUT_ARITY Outs at 1..=ARITY, and the Fault
        // LAST (ROUTE-06). The old OFFSET clause ("the first Out keeps its pre-widening
        // nub (1,2)") is retired by the "Edits keep middle layout" decision: the first Out now sits on
        // the middle row, where the reseat rule seats it, and every board that docked
        // the old cell was redrawn onto the new one.
        let (foot, ports) = port_catalog(machine_kind::ROUTER);
        assert_eq!(foot, Footprint { w: 2, h: 3, rot: 0 }, "the frozen 2x3 base is unmoved");
        assert_eq!(ports[0].role, Role::In, "index 0 is the In");
        assert_eq!(ports[0].side, Side::W, "facing W");
        let arity = ROUTER_OUT_ARITY as usize;
        assert!(
            ports[1..=arity].iter().all(|p| p.role == Role::Out && p.side == Side::E),
            "indices 1..=ROUTER_OUT_ARITY are the E-facing Outs",
        );
        let last = ports.len() - 1;
        assert_eq!(last, arity + 1, "nothing between the Outs and the Fault");
        assert_eq!(
            ports[last],
            Port { local_offset: (0, 2), side: Side::S, role: Role::Fault, medium: Medium::Mechanical },
            "and the LAST entry is the PILE-10 Fault nub, which sorts last under ROUTE-06",
        );
    }

    #[test]
    fn port_catalog_every_port_lies_inside_its_declared_footprint() {
        // What `upcast`'s port-in-footprint guard and the snapshot gate's
        // `PortOutOfFootprint` both check on untrusted input (T-63-58), asserted here on
        // the catalog itself so a widened arm cannot ship a port outside its own box.
        for kind in CATALOG_KINDS {
            let (foot, ports) = port_catalog(kind);
            for (i, p) in ports.iter().enumerate() {
                let (x, y) = p.local_offset;
                assert!(
                    x >= 0 && y >= 0 && x < i32::from(foot.w) && y < i32::from(foot.h),
                    "kind {kind} port {i} at {:?} is outside its {}x{} footprint",
                    p.local_offset,
                    foot.w,
                    foot.h,
                );
            }
        }
    }

    #[test]
    fn place_router_preset_strips_the_whole_catalog_port_set() {
        // T-63-59. BOTH halves of the symmetric operation are DERIVED, not written
        // down: the strip count comes from the catalog and the seed count comes from
        // `router_preset_ports`. With a hard-coded strip an HTTP Router would keep
        // `ROUTER_OUT_ARITY - 1` bare MECHANICAL Outs, and a wire drawn from one of
        // them would be a MediumMismatch the user could not explain from what the
        // palette said it placed. With a hard-coded SEED the placed Router carried two
        // Outs while the catalog said three, which is the defect ROUTE-02 closes.
        let mut session = GridSession::new(11);
        session
            .place_router_preset(Medium::Electrical, 0, 0)
            .expect("the preset places");
        let id = session.core().state.occupied((0, 0)).expect("router at (0,0)");
        let ports = session
            .core()
            .state
            .ports_of(id)
            .expect("the preset router has ports")
            .to_vec();
        // The EQUALITY that is the point of this phase: a placed preset Router carries
        // the SAME Out count as the catalog, compared derived-to-derived.
        let (_, catalog_ports) = port_catalog(machine_kind::ROUTER);
        assert_eq!(
            count_role(&ports, Role::Out),
            count_role(&catalog_ports, Role::Out),
            "a placed preset Router has the catalog's Out arity, so a two-rule table has \
             somewhere to send its second branch",
        );
        assert_eq!(
            ports.len(),
            router_preset_ports(Medium::Electrical).len(),
            "the placed port list is exactly what the single producer minted",
        );
        // Since 85-05 (D-22) the preset carries a Fault, at Mechanical on both presets. A
        // surviving bare catalog port would be Mechanical too, so the In and Outs are
        // checked at the preset medium and the Fault is checked to be the ONE Mechanical
        // port: a leftover bare Fault would make two, and a leftover In or Out would
        // fail the first check.
        assert!(
            ports.iter().filter(|p| p.role != Role::Fault).all(|p| p.medium == Medium::Electrical),
            "every surviving In and Out speaks the preset medium, no bare catalog port survived",
        );
        assert_eq!(
            ports.iter().filter(|p| p.medium == Medium::Mechanical).map(|p| p.role).collect::<Vec<_>>(),
            vec![Role::Fault],
            "the only Mechanical port is the preset's one Fault",
        );
        let removes = session
            .edit_log()
            .iter()
            .filter(|r| matches!(r.op, EditOp::RemovePort { .. }))
            .count();
        assert_eq!(
            removes,
            catalog_ports.len(),
            "one RemovePort per catalog port, counted from the catalog",
        );
        let adds = session
            .edit_log()
            .iter()
            .filter(|r| matches!(r.op, EditOp::AddPort { .. }))
            .count();
        assert_eq!(
            adds,
            router_preset_ports(Medium::Electrical).len(),
            "one AddPort per preset port, counted from the single producer",
        );
    }

    #[test]
    fn place_router_preset_footprint_floors_at_the_frozen_router_base() {
        // The widened seed does NOT move the placement ghost or the claimed cells:
        // `grow_to_fit`'s min height is max(n_in, n_out) = ROUTER_OUT_ARITY, and the
        // frozen 2x3 base already holds exactly that many rows (the compile-time
        // assertion in `port_catalog`'s Router arm is the other half of this rule).
        let mut session = GridSession::new(11);
        session
            .place_router_preset(Medium::Mechanical, 0, 0)
            .expect("the preset places");
        let id = session.core().state.occupied((0, 0)).expect("router at (0,0)");
        let placed = session
            .core()
            .state
            .footprint_of(id)
            .expect("the placed router has a footprint");
        let (base, _) = port_catalog(machine_kind::ROUTER);
        assert_eq!(
            placed, base,
            "a preset Router still floors at the frozen Router base at the widened arity",
        );
    }

    #[test]
    fn port_catalog_source_1x1_out_only() {
        let (foot, ports) = port_catalog(machine_kind::SOURCE);
        assert_eq!(foot, Footprint { w: 1, h: 1, rot: 0 });
        assert_eq!(
            ports,
            vec![Port { local_offset: (0, 0), side: Side::E, role: Role::Out, medium: Medium::Mechanical }],
        );
    }

    #[test]
    fn port_catalog_sink_1x1_in_then_fault_on_the_one_cell() {
        // RENAMED and REWRITTEN in phase 71, not deleted. It read
        // `port_catalog_sink_1x1_in_only` and pinned a single In, which was correct and
        // is now false: PILE-10 gives the Sink a spatial `Role::Fault` nub so a user can
        // drag a belt onto it. The name went with the assertion, because a test called
        // `..._in_only` asserting two ports is worse than either.
        //
        // BOTH ports sit on the ONE cell (the ENDPOINT arm's precedent), so the declared
        // box is UNCHANGED at 1x1 and stays equal to `base_footprint(Node::Sink)` in the
        // core. `fault_reconciliation.rs` asserts that parity directly.
        let (foot, ports) = port_catalog(machine_kind::SINK);
        assert_eq!(foot, Footprint { w: 1, h: 1, rot: 0 }, "the 1x1 box did NOT grow");
        assert_eq!(
            ports,
            vec![
                Port { local_offset: (0, 0), side: Side::W, role: Role::In, medium: Medium::Mechanical },
                Port { local_offset: (0, 0), side: Side::S, role: Role::Fault, medium: Medium::Mechanical },
            ],
        );
    }

    #[test]
    fn port_catalog_tee_2x2_one_in_two_out() {
        let (foot, ports) = port_catalog(machine_kind::TEE);
        assert_eq!(foot, Footprint { w: 2, h: 2, rot: 0 });
        assert_eq!(count_role(&ports, Role::In), 1, "TEE has 1 In");
        assert_eq!(count_role(&ports, Role::Out), 2, "TEE fans out to 2");
        assert!(ports.iter().filter(|p| p.role == Role::In).all(|p| p.side == Side::W));
        assert!(ports.iter().filter(|p| p.role == Role::Out).all(|p| p.side == Side::E));
    }

    #[test]
    fn port_catalog_balancer_2x2_two_in_two_out() {
        let (foot, ports) = port_catalog(machine_kind::BALANCER);
        assert_eq!(foot, Footprint { w: 2, h: 2, rot: 0 });
        assert_eq!(count_role(&ports, Role::In), 2, "BALANCER has 2 In");
        assert_eq!(count_role(&ports, Role::Out), 2, "BALANCER has 2 Out");
        assert!(ports.iter().filter(|p| p.role == Role::In).all(|p| p.side == Side::W));
        assert!(ports.iter().filter(|p| p.role == Role::Out).all(|p| p.side == Side::E));
    }

    #[test]
    fn port_catalog_merge_2x2_two_in_one_out() {
        let (foot, ports) = port_catalog(machine_kind::MERGE);
        assert_eq!(foot, Footprint { w: 2, h: 2, rot: 0 });
        assert_eq!(count_role(&ports, Role::In), 2, "MERGE fans in from 2");
        assert_eq!(count_role(&ports, Role::Out), 1, "MERGE has 1 Out");
    }

    #[test]
    fn port_catalog_fan_side_count_equals_default_arity() {
        // 17-RESEARCH A5 / key-link: docks must never reference a port the minted
        // node never emits on. The fan side of each multi-port router kind == the
        // arity fold_place mints.
        assert_eq!(
            count_role(&port_catalog(machine_kind::TEE).1, Role::Out),
            DEFAULT_ARITY,
            "TEE fan-out count == DEFAULT_ARITY",
        );
        assert_eq!(
            count_role(&port_catalog(machine_kind::MERGE).1, Role::In),
            DEFAULT_ARITY,
            "MERGE fan-in count == DEFAULT_ARITY",
        );
        assert_eq!(
            count_role(&port_catalog(machine_kind::BALANCER).1, Role::In),
            DEFAULT_ARITY,
            "BALANCER In count == DEFAULT_ARITY",
        );
        assert_eq!(
            count_role(&port_catalog(machine_kind::BALANCER).1, Role::Out),
            DEFAULT_ARITY,
            "BALANCER Out count == DEFAULT_ARITY",
        );
    }

    // ───────────────── PORT-06/07 (36-02): W1 base-parity + AddPort/RemovePort validate ─────────────────

    #[test]
    fn base_footprint_equals_port_catalog_for_every_operator_kind() {
        use fabrico_core::state::base_footprint;
        // W1 (the FOOT-05 covering test): the in-core per-kind FLOOR the fold clamps to
        // (`base_footprint`) MUST equal the command catalog's mint dims (`port_catalog`)
        // for EVERY operator kind — otherwise a placed machine's FIRST port-edit would
        // silently re-floor it to a DIFFERENT base (in-core/catalog drift, the top
        // milestone risk). `fabrico-command` is the ONE crate that sees BOTH functions.
        let mut session = GridSession::new(1);
        // HANDLER WAS EXCLUDED HERE UNTIL PLAN 72-06, and the exclusion closed itself
        // exactly as it was built to. `port_catalog` gained a HANDLER arm in plan 72-05
        // while `fold_place` (fabrico-core) had none, so a `Place{HANDLER}` was ACCEPTED
        // and minted NOTHING, and this test needs a minted node to ask `base_footprint`
        // about. Rather than a silent skip, the reason was a LIVE ASSERTION below the
        // loop ("a Place{HANDLER} mints nothing today"), which reddened on the commit
        // that added the fold arm and named this fix in its own message. Plan 72-06
        // deleted the `folds_today` filter and the assertion together: HANDLER now runs
        // the base-parity loop with every other placeable kind, which is a STRONGER
        // statement than the exclusion it replaces.
        for (i, &kind) in CATALOG_KINDS.iter().enumerate() {
            // Spacing 10 >> the 3x3 max footprint keeps every placement collision-free.
            let cx = (i as i32) * 10;
            session
                .apply(GridCommand::Place { kind, cell_x: cx, cell_y: 0 })
                .expect("placed");
            let id = *session.core().last_tick.placed.last().expect("minted");
            let node = session.core().state.node(id).expect("live node");
            assert_eq!(
                base_footprint(node),
                port_catalog(kind).0,
                "kind {kind}: in-core base_footprint must equal port_catalog floor \
                 (FOOT-05 — no operator can shrink below its frozen base)",
            );
        }
        // THE INVERSE OF THE ASSERTION THIS TEST CARRIED UNTIL PLAN 72-06. It used to
        // assert that a `Place{HANDLER}` minted NOTHING, so that the exclusion above
        // could not outlive its reason. The fold arm landed, so the statement flips: a
        // `Place{HANDLER}` MINTS, and it is kept as a live assertion rather than
        // deleted, because "HANDLER is in the loop above" is only load-bearing while
        // the loop's `.expect("placed")` can actually fail for that byte. Without this
        // line a future regression that dropped the fold arm would make the loop's
        // HANDLER iteration panic on `expect("minted")` with no explanation attached.
        // `last_tick.placed` is per-TICK and is cleared by each `apply`, so a NON-EMPTY
        // list after this one apply is exactly "this Place minted something".
        session
            .apply(GridCommand::Place { kind: machine_kind::HANDLER, cell_x: 500, cell_y: 0 })
            .expect("the command layer ACCEPTS a Place{HANDLER}: it has a catalog arm");
        assert!(
            !session.core().last_tick.placed.is_empty(),
            "a Place{{HANDLER}} minted NOTHING, so `fold_place` has lost the HANDLER arm \
             plan 72-06 gave it. A catalog kind the palette offers and the fold refuses \
             is the overstating-label defect SERVE-03 exists to close.",
        );
    }

    // ───────────────── D-26 / R-37: the HANDLER naming predicate (72-06) ─────────────────

    #[test]
    fn a_placed_handler_is_named_handler_and_a_placed_factory_is_not() {
        // The POSITIVE half of D-26, and it is asserted through the PROJECTION rather
        // than by calling the predicate directly, because `GridView.kinds` is the
        // Delete-time kind CAPTURE the inverse target-identity guard compares against.
        // A predicate that is right and a projection that never calls it would pass a
        // direct test and still delete the wrong node.
        let mut session = GridSession::new(1);
        let (handler, _) = placed(&mut session, machine_kind::HANDLER, 0, 0);
        let (factory, _) = placed(&mut session, machine_kind::FACTORY, 20, 0);
        let core_ref: &Core = session.core();
        let lookup = session.view().lookup(core_ref);

        assert_eq!(
            lookup.kind_of(handler),
            Some(machine_kind::HANDLER),
            "a placed HANDLER projects the HANDLER byte. Both machines are a \
             `Node::Factory` (D-11 adds no Node variant), so the ONLY thing that can \
             tell them apart is the port list `is_handler_shape` reads"
        );
        assert_eq!(
            lookup.kind_of(factory),
            Some(machine_kind::FACTORY),
            "a placed FACTORY still projects FACTORY: its catalog ports are mechanical, \
             so it fails BOTH halves of the naming predicate"
        );
    }

    #[test]
    fn the_naming_predicate_is_stricter_than_the_servicing_predicate() {
        // R-6 / R-37, asserted rather than argued, on the EXACT board that separates the
        // two rules: a Factory with an electrical In at port 0 and NO electrical Out.
        // That is the shipped demo board's genesis handler as it stood before D-26, and
        // it is what goldens 0023/0024 become when plan 72-12 seeds their handlers.
        //
        // WITHOUT THIS TEST the two candidate rules D-26 rejected are indistinguishable
        // from the one it took. "Port 0 is Electrical" alone would name this machine a
        // HANDLER while it has no way to send an answer back, which is the
        // overstating-label defect SERVE-03 exists to close.
        use fabrico_core::admit::{self, AdmitClass};
        use fabrico_core::state::{Medium, Port, Role, Side};

        let mut session = GridSession::new(1);
        let (id, _) = placed(&mut session, machine_kind::FACTORY, 0, 0);
        session.core_mut().state.set_ports(
            id,
            vec![Port {
                local_offset: (0, 0),
                side: Side::W,
                role: Role::In,
                medium: Medium::Electrical,
            }],
        );

        // SERVICED: `inbox_class` reads port 0's declared medium and says "wire request".
        assert_eq!(
            admit::inbox_class(&session.core().state, id, 0),
            AdmitClass::Electrical,
            "port 0 is electrical, so this machine IS serviced as a handler (D-16). \
             Without this the test below could pass on a board nothing services and \
             would be measuring nothing"
        );
        // NOT NAMED: the naming predicate also demands an electrical Out.
        assert!(
            !crate::grid_view::is_handler_shape(
                session.core().state.node(id).expect("live node"),
                session.core().state.ports_of(id),
            ),
            "a machine that is SERVICED as a handler is NOT thereby NAMED one. The \
             naming rule is the STRICTER of the two, on purpose (D-26, R-37): it also \
             demands an electrical Out, because a machine with no way to answer must \
             not carry the name of the machine that answers"
        );
    }

    #[test]
    fn a_handlers_single_out_makes_a_second_return_cable_refused() {
        // THE CLAIM PLAN 72-05 COULD ONLY DOCUMENT, NOW ASSERTED. `port_catalog(HANDLER)`
        // declares ONE electrical Out, and three places record that this arity is
        // load-bearing rather than merely sufficient: with a single Out a second Route's
        // return cable is refused, so the one-request-one-reply shape is the only board
        // a user can build (D-01/D-02). Nothing tested it, because until plan 72-06's
        // fold arm there was no way to PLACE a Handler to draw a second wire out of.
        // 72-05's summary named this as NOT MET item 1 and asked the plan after it to
        // close it. This is that assertion.
        let mut session = GridSession::new(1);
        let (_handler, h) = placed(&mut session, machine_kind::HANDLER, 0, 0);
        let (_caller_a, a) = placed(&mut session, machine_kind::ENDPOINT, 20, 0);
        let (_caller_b, b) = placed(&mut session, machine_kind::ENDPOINT, 30, 0);

        // The Handler's ONE electrical Out is catalog index 1. Its In at index 0 and the
        // Endpoint's In at index 0 are both electrical, so nothing here is refused for a
        // medium or a role reason.
        session
            .apply(GridCommand::DrawWire { from_node: h, from_port: 1, to_node: a, to_port: 0 })
            .expect("the FIRST return cable out of the Handler's one Out is accepted");
        let second = session
            .apply(GridCommand::DrawWire { from_node: h, from_port: 1, to_node: b, to_port: 0 });
        assert!(
            matches!(second, Err(CommandError::PortOccupied)),
            "a SECOND cable out of the Handler's only Out is refused PortOccupied, which \
             is what makes one-request-one-reply the only buildable shape. Got: {second:?}"
        );
        // And the refusal is about OCCUPANCY, not about running out of ports: index 2 is
        // the Fault nub and is refused for a DIFFERENT, typed reason. Without this the
        // test above would pass on a Handler that had no port 1 at all.
        let fault_leg = session
            .apply(GridCommand::DrawWire { from_node: h, from_port: 2, to_node: b, to_port: 0 });
        assert!(
            matches!(fault_leg, Err(CommandError::IncompatiblePorts)),
            "a wire out of the Fault nub is refused for its own reason (T-63-17), so the \
             PortOccupied above is genuinely about the single Out being taken. Got: \
             {fault_leg:?}"
        );
    }

    /// How many further `Role::Out` ports a freshly placed Router's BASE box still has
    /// room for before `grow_to_fit` has to grow it: `base.h - ROUTER_OUT_ARITY`,
    /// derived so a test about GROWING stays a test about growing when the catalog
    /// arity moves. It is `0` at the 63-07 arity: the base box is full.
    fn router_out_headroom() -> u16 {
        port_catalog(machine_kind::ROUTER).0.h - ROUTER_OUT_ARITY
    }

    /// Place `kind` at `(cx, cy)` and return `(session's minted NodeId, its u64 handle)`.
    fn placed(session: &mut GridSession, kind: u8, cx: i32, cy: i32) -> (NodeId, u64) {
        session
            .apply(GridCommand::Place { kind, cell_x: cx, cell_y: cy })
            .expect("placed");
        let id = *session.core().last_tick.placed.last().expect("minted");
        let handle = session.view().handle_of(id).expect("minted node has a handle");
        (id, handle)
    }

    /// RE-AUTHORED IN 74.1-16 (was `add_port_on_router_tracks_grow_to_fit_and_freezes_editop_addport`).
    /// The add half is unchanged: on a hole-free list the grown box is still
    /// `grow_to_fit(base, ports)`. The removal half was "floors back to the catalog base";
    /// by design, a removal never shrinks the machine, so the
    /// removal keeps the grown box and only the UNDO of the add puts the base back.
    #[test]
    fn add_port_on_router_grows_by_grow_to_fit_and_only_its_undo_shrinks_it() {
        let mut session = GridSession::new(3);
        let (router, handle) = placed(&mut session, machine_kind::ROUTER, 5, 5);
        // The Router base is 2x3 with 1 In and ROUTER_OUT_ARITY Outs (63-07), which is
        // exactly what the 2x3 box holds, so the FIRST added Out grows it. Everything
        // below is derived from the catalog rather than from the arity as it stands
        // today: this test asserts the RULE (footprint == grow_to_fit(base, ports)) and
        // must not have to be rewritten if the arity ever moves again.
        assert_eq!(
            session.core().state.footprint_of(router),
            Some(port_catalog(machine_kind::ROUTER).0),
            "a freshly placed Router sits on its catalog base",
        );
        session
            .apply(GridCommand::AddPort {
                node: handle,
                role: port_role::OUT,
                side: 1,
                medium: port_medium::MECHANICAL,
            })
            .expect("AddPort accepted");
        // The frozen record is EditOp::AddPort on the resolved node.
        assert!(
            matches!(session.edit_log().last().map(|r| &r.op), Some(EditOp::AddPort { node, .. }) if *node == router),
            "the accepted AddPort freezes EditOp::AddPort on the resolved node",
        );
        // The stored footprint equals grow_to_fit(base, the stored port list): the ONE
        // rule, checked against the catalog rather than against a transcribed number.
        let ports = session.core().state.ports_of(router).expect("router ports").to_vec();
        assert_eq!(
            count_role(&ports, Role::Out),
            ROUTER_OUT_ARITY + 1,
            "the add took the Router one Out past its catalog arity",
        );
        assert_eq!(
            session.core().state.footprint_of(router),
            Some(grow_to_fit(port_catalog(machine_kind::ROUTER).0, &ports)),
            "the fold's footprint is grow_to_fit(base, ports) — validated == folded",
        );
        assert_eq!(
            session.core().state.footprint_of(router),
            Some(Footprint { w: 2, h: ROUTER_OUT_ARITY + 1, rot: 0 }),
            "one Out past the base arity grows the height by exactly one row",
        );
        assert!(
            matches!(
                session.edit_log().last().map(|r| &r.op),
                Some(EditOp::AddPort { seat: PortSeat::Auto, .. })
            ),
            "the forward gesture freezes the Auto seat",
        );
        // 74.1-16: removing it again KEEPS the grown box (a removal never shrinks the
        // machine). The removed index is the LAST, which is the port just added.
        let grown = session.core().state.footprint_of(router);
        let last = u16::try_from(ports.len() - 1).expect("port index fits u16");
        session
            .apply(GridCommand::RemovePort { node: handle, index: last })
            .expect("RemovePort accepted");
        assert_eq!(
            session.core().state.footprint_of(router),
            grown,
            "removing the surplus Out keeps the grown box",
        );
        // ...and undoing the removal and then the add puts the catalog base back: the
        // add's inverse carries the box it grew from.
        session.apply(GridCommand::Undo).expect("undo the removal");
        session.apply(GridCommand::Undo).expect("undo the add");
        assert_eq!(
            session.core().state.footprint_of(router),
            Some(port_catalog(machine_kind::ROUTER).0),
            "undoing the add restores the catalog base",
        );
    }

    #[test]
    fn add_port_preserves_live_rotation_and_rotates_new_port_world_pos() {
        // WR-01 regression: a headless Place -> Rotate -> AddPort sequence must KEEP the
        // machine's orientation (its ports rotate WITH the box), not silently snap the
        // footprint back to rot 0. Before the fix the port-edit resize floored `rot` to
        // `base_footprint(kind).rot` (= 0), discarding the live rotation.
        let mut session = GridSession::new(7);
        let (router, handle) = placed(&mut session, machine_kind::ROUTER, 5, 5);
        let anchor = session.core().state.cell_of(router).expect("router anchor");
        // Rotate CW (rot 0 -> 1): the 2x3 box now occupies a 3x2 effective footprint.
        session
            .apply(GridCommand::Rotate { node: handle, ccw: false })
            .expect("rotate accepted");
        assert_eq!(
            session.core().state.footprint_of(router).map(|f| f.rot),
            Some(1),
            "precondition: the router is rotated to rot 1",
        );
        // Add one Out to the rotated machine.
        session
            .apply(GridCommand::AddPort {
                node: handle,
                role: port_role::OUT,
                side: 1,
                medium: port_medium::MECHANICAL,
            })
            .expect("AddPort accepted on the rotated router");
        let fp = session.core().state.footprint_of(router).expect("router footprint");
        assert_eq!(
            fp.rot, 1,
            "AddPort PRESERVES the machine's live rotation (WR-01) instead of resetting to rot 0",
        );
        // The new port's WORLD placement flows through the Phase-10 rotate geometry: its
        // world SIDE is the rot-0 side turned one quarter (p.side + rot), so the rot-1
        // placement differs from the rot-0 placement the pre-fix code would have produced.
        let ports = session.core().state.ports_of(router).expect("router ports").to_vec();
        let last = ports.last().expect("the just-added Out port");
        let (world_cell_rot1, world_side_rot1) = port_world(anchor, fp.w, fp.h, fp.rot, last);
        let (_world_cell_rot0, world_side_rot0) = port_world(anchor, fp.w, fp.h, 0, last);
        assert_ne!(
            world_side_rot1, world_side_rot0,
            "the new port faces the ROTATED world side (ports rotate with the machine)",
        );
        // The new port's world cell lands inside the machine's rotated occupied box.
        let occupied: Vec<(i32, i32)> =
            cells_of_footprint(anchor, fp.w, fp.h, fp.rot).collect();
        assert!(
            occupied.contains(&world_cell_rot1),
            "the new port's rotated world cell lies on the machine's rotated footprint",
        );
    }

    #[test]
    fn add_port_grown_footprint_collision_rejects_atomically() {
        let mut session = GridSession::new(3);
        let (_router, handle) = placed(&mut session, machine_kind::ROUTER, 5, 5);
        // Block the cell the router would claim when it grows one row past its base
        // (row y = 5 + base.h).
        placed(&mut session, machine_kind::SOURCE, 5, 8);
        // HEADROOM: how many Outs the base box still has room for. Derived from the
        // catalog, because the Router's base arity moved in 63-07 and a literal here
        // would have made this test assert the wrong thing silently rather than fail.
        for _ in 0..router_out_headroom() {
            session
                .apply(GridCommand::AddPort {
                    node: handle,
                    role: port_role::OUT,
                    side: 1,
                    medium: port_medium::MECHANICAL,
                })
                .expect("pre-growth AddPort accepted");
        }
        let before = snapshot(session.core());
        let log_len = session.edit_log().len();
        let err = session
            .apply(GridCommand::AddPort {
                node: handle,
                role: port_role::OUT,
                side: 1,
                medium: port_medium::MECHANICAL,
            })
            .expect_err("the grown footprint collides");
        assert_eq!(err, CommandError::GrowBlocked);
        assert_eq!(snapshot(session.core()), before, "reject leaves the core byte-identical (SC#2)");
        assert_eq!(session.edit_log().len(), log_len, "reject appends no record");
    }

    #[test]
    fn add_port_grown_footprint_off_grid_rejects_atomically() {
        let mut session = GridSession::new(3);
        // Router base 2x3 at the very bottom edge: rows 510,511,512 fit; growing one row
        // past the base would need row 513 > GRID_MAX (512) -> OutOfBounds.
        let (_router, handle) = placed(&mut session, machine_kind::ROUTER, 0, 510);
        for _ in 0..router_out_headroom() {
            session
                .apply(GridCommand::AddPort {
                    node: handle,
                    role: port_role::OUT,
                    side: 1,
                    medium: port_medium::MECHANICAL,
                })
                .expect("pre-growth AddPort accepted");
        }
        let before = snapshot(session.core());
        let err = session
            .apply(GridCommand::AddPort {
                node: handle,
                role: port_role::OUT,
                side: 1,
                medium: port_medium::MECHANICAL,
            })
            .expect_err("the grown footprint leaves the grid");
        assert_eq!(err, CommandError::OutOfBounds);
        assert_eq!(snapshot(session.core()), before, "reject leaves the core byte-identical (SC#2)");
    }

    #[test]
    fn remove_port_out_of_range_index_rejects_byte_identical() {
        let mut session = GridSession::new(3);
        let (_router, handle) = placed(&mut session, machine_kind::ROUTER, 5, 5);
        let before = snapshot(session.core());
        let log_len = session.edit_log().len();
        // Router has 2 ports (indices 0,1); index 5 is out of range.
        let err = session
            .apply(GridCommand::RemovePort { node: handle, index: 5 })
            .expect_err("out-of-range index rejects");
        assert_eq!(err, CommandError::NoSuchPort);
        assert_eq!(snapshot(session.core()), before, "reject leaves the core byte-identical (SC#2)");
        assert_eq!(session.edit_log().len(), log_len, "reject appends no record");
    }

    // ─────────── ROUTE-03 (65-04): the router target-port accept envelope ───────────

    /// The wire-side `MachineConfig::Router` a target-port test applies. `routes` names
    /// ROUTING KEYS, never catalog indices.
    fn wire_router_config(
        rule_ports: &[PortId],
        default: Option<PortId>,
    ) -> fabrico_protocol::MachineConfig {
        fabrico_protocol::MachineConfig::Router {
            routes: rule_ports
                .iter()
                .map(|port| {
                    (
                        fabrico_protocol::RouteKey { offset: 0, expect: b"A".to_vec() },
                        *port,
                    )
                })
                .collect(),
            default,
        }
    }

    /// How many `Role::Out` ports the resolved node declares: the SAME count the
    /// `Configure` arm bounds a routing key against, derived here rather than restated
    /// so these tests keep testing the rule when the arity moves.
    fn live_out_count(session: &GridSession, id: NodeId) -> PortId {
        let ports = session.core().state.ports_of(id).expect("a placed node declares ports");
        count_role(ports, Role::Out)
    }

    #[test]
    fn configure_router_table_within_the_live_out_count_is_accepted() {
        let mut session = GridSession::new(3);
        let (router, handle) = placed(&mut session, machine_kind::ROUTER, 5, 5);
        let outs = live_out_count(&session, router);
        assert!(outs >= 2, "this test needs at least two Outs to name distinct keys");
        let log_len = session.edit_log().len();
        session
            .apply(GridCommand::Configure {
                node: handle,
                config: wire_router_config(&[0, outs - 1], Some(0)),
            })
            .expect("every key below the live Out count is addressable");
        assert_eq!(
            session.edit_log().len(),
            log_len + 1,
            "an accepted Configure appends exactly one record"
        );
    }

    #[test]
    fn configure_router_rule_port_at_the_live_out_count_rejects_with_no_record() {
        let mut session = GridSession::new(3);
        let (router, handle) = placed(&mut session, machine_kind::ROUTER, 5, 5);
        let outs = live_out_count(&session, router);
        let before = snapshot(session.core());
        let log_len = session.edit_log().len();
        // `outs` is the FIRST key past the end: keys run 0 ..< outs.
        let err = session
            .apply(GridCommand::Configure {
                node: handle,
                config: wire_router_config(&[outs], None),
            })
            .expect_err("a rule naming a port the board does not have rejects");
        assert_eq!(err, CommandError::NoSuchPort);
        assert_eq!(snapshot(session.core()), before, "reject leaves the core byte-identical (SC#2)");
        assert_eq!(session.edit_log().len(), log_len, "reject appends no record");
    }

    #[test]
    fn configure_router_default_past_the_live_out_count_rejects() {
        let mut session = GridSession::new(3);
        let (router, handle) = placed(&mut session, machine_kind::ROUTER, 5, 5);
        let outs = live_out_count(&session, router);
        let log_len = session.edit_log().len();
        let err = session
            .apply(GridCommand::Configure {
                node: handle,
                config: wire_router_config(&[0], Some(outs + 7)),
            })
            .expect_err("a default naming a port the board does not have rejects");
        assert_eq!(err, CommandError::NoSuchPort, "same variant as the rule-port reject");
        assert_eq!(session.edit_log().len(), log_len, "reject appends no record");
    }

    #[test]
    fn configure_router_default_naming_the_reserved_fault_port_rejects() {
        let mut session = GridSession::new(3);
        let (_router, handle) = placed(&mut session, machine_kind::ROUTER, 5, 5);
        let log_len = session.edit_log().len();
        // FAULT_PORT is u16::MAX, a RESERVED routing key with no Port record, so the
        // count-based bound rejects it for free: the accepted set is 0 ..< out_count
        // with no sentinel hole.
        let err = session
            .apply(GridCommand::Configure {
                node: handle,
                config: wire_router_config(&[0], Some(FAULT_PORT)),
            })
            .expect_err("the reserved fault port is not an addressable routing key");
        assert_eq!(err, CommandError::NoSuchPort);
        assert_eq!(session.edit_log().len(), log_len, "reject appends no record");
    }

    #[test]
    fn configure_router_table_aimed_at_a_non_router_rejects_rather_than_folding_to_nothing() {
        let mut session = GridSession::new(3);
        // A FACTORY: In + Out + Fault, so exactly ONE Role::Out port.
        let (factory, handle) = placed(&mut session, machine_kind::FACTORY, 5, 5);
        let outs = live_out_count(&session, factory);
        assert_eq!(outs, 1, "a Factory declares exactly one Out");
        let log_len = session.edit_log().len();
        // Before 65-04 this was accepted and folded to a panic-free no-op, so the user
        // got a certified record that did nothing and no message.
        let err = session
            .apply(GridCommand::Configure {
                node: handle,
                config: wire_router_config(&[outs], None),
            })
            .expect_err("the check runs on the CONFIG's shape, not on the node's kind");
        assert_eq!(err, CommandError::NoSuchPort);
        assert_eq!(session.edit_log().len(), log_len, "reject appends no record");
    }

    #[test]
    fn configure_router_empty_table_with_no_default_is_accepted() {
        let mut session = GridSession::new(3);
        let (_router, handle) = placed(&mut session, machine_kind::ROUTER, 5, 5);
        let log_len = session.edit_log().len();
        // A legal core state: an empty table with no default means every item faults.
        session
            .apply(GridCommand::Configure {
                node: handle,
                config: wire_router_config(&[], None),
            })
            .expect("an empty table with no default is a legal core state");
        assert_eq!(session.edit_log().len(), log_len + 1, "it appends its record");
    }

    #[test]
    fn configure_non_router_config_is_untouched_by_the_target_port_check() {
        let mut session = GridSession::new(3);
        let (_factory, factory_h) = placed(&mut session, machine_kind::FACTORY, 5, 5);
        let (_router, router_h) = placed(&mut session, machine_kind::ROUTER, 12, 5);
        let log_len = session.edit_log().len();
        session
            .apply(GridCommand::Configure {
                node: factory_h,
                config: fabrico_protocol::MachineConfig::Factory {
                    source: "export default (i) => i;".to_owned(),
                },
            })
            .expect("a Factory config never meets the router target-port check");
        // Wrong-kind is STILL a resolve-only accept for every non-Router config shape:
        // the new check narrowed the Router shape only.
        session
            .apply(GridCommand::Configure {
                node: router_h,
                config: fabrico_protocol::MachineConfig::Belt { ticks_per_slot: 9 },
            })
            .expect("a Belt config aimed at a Router is still a resolve-only accept");
        assert_eq!(session.edit_log().len(), log_len + 2, "both appended their records");
    }

    // --------- The route-table SIZE bound: the write half of the load-time guard ---------
    //
    // WHAT THESE TESTS EXIST TO STOP, stated once so no later reader files them as
    // duplicates of `fabrico-host`'s load-side pair. Before this bound, a Match-text
    // pattern one byte over `MAX_ROUTE_EXPECT_BYTES` was accepted here, folded, written
    // to the certified edit log and saved, and the saved bundle then permanently refused
    // to load. The property the whole group is about is the LAST test in it: the command
    // layer's accept envelope and `load_project`'s refusal envelope are complements, so
    // nothing this layer accepts can be refused on load.
    //
    // MUTATION-PROVED on 2026-08-22, by RUNNING two mutations rather than describing
    // them. ONE mutation is not enough here, because this group guards a bound in BOTH
    // directions and a deletion can only ever redden the refuse-side half.
    //
    //   M1, DELETE the `routes.len() > MAX_ROUTES || ...` guard from the `Configure`
    //       arm. Reddened the two over-cap tests and the agreement test; the two
    //       at-cap tests stayed green, WHICH IS CORRECT AND NOT DECORATIVE - removing a
    //       guard cannot make an accept-test fail, so M1 is the wrong mutation for them
    //       and M2 is their proof.
    //   M2, WEAKEN the guard by an off-by-one (`>` becomes `>=`), the exact defect that
    //       would refuse a legal table. Reddened the two at-cap tests and the agreement
    //       test; the two over-cap tests stayed green, which is again correct - a
    //       stricter guard still refuses what was already refused.
    //
    // The agreement test is the only one that reddens under BOTH, because it is the only
    // one that asserts the two envelopes are complements rather than asserting one side.
    // Every observed message is recorded verbatim beside its assertion below.

    /// A wire-side `Router` table of `rules` entries, each carrying an `expect` pattern
    /// of `expect_len` bytes, all aimed at routing key 0.
    ///
    /// EVERY SIZE IS DERIVED FROM THE CONSTANT, never a literal `1025` or `1024`. A
    /// literal here would keep passing if a cap moved and would stop testing the rule.
    fn wire_router_table(rules: usize, expect_len: usize) -> fabrico_protocol::MachineConfig {
        fabrico_protocol::MachineConfig::Router {
            routes: (0..rules)
                .map(|i| {
                    (
                        fabrico_protocol::RouteKey {
                            offset: 0,
                            // Vary the byte so no two rules are identical: a dedup
                            // anywhere in the path would otherwise shrink the table and
                            // make an over-cap case pass vacuously.
                            expect: vec![(i % 251) as u8; expect_len],
                        },
                        0,
                    )
                })
                .collect(),
            default: None,
        }
    }

    /// `load_project`'s route-table refusal predicate, expressed over the SAME two
    /// constants it reads (`fabrico_host::project.rs`, the `EditRouteTableTooLong` /
    /// `EditRoutePatternTooLong` arms of the ELOG-05 per-record loop).
    ///
    /// It is restated rather than called because `fabrico-command` is headless by
    /// contract: the `deps_are_headless` fence forbids a `fabrico-host` dependency, so
    /// the host function is not linkable from here. What keeps the restatement honest is
    /// that it takes its numbers from `fabrico_core::edit` exactly as the host does, so
    /// there is still ONE home for the bound. The executable half of the same claim is
    /// `edit::upcast`, which IS callable from here and applies the identical pair; the
    /// round-trip test below drives it on the real produced record.
    fn load_bound_admits(config: &MachineConfig) -> bool {
        match config {
            MachineConfig::Router { routes, .. } => {
                routes.len() <= MAX_ROUTES
                    && routes
                        .iter()
                        .all(|(key, _)| key.expect.len() <= MAX_ROUTE_EXPECT_BYTES)
            }
            _ => true,
        }
    }

    #[test]
    fn configure_router_pattern_one_byte_over_the_cap_rejects_with_no_record() {
        let mut session = GridSession::new(3);
        let (_router, handle) = placed(&mut session, machine_kind::ROUTER, 5, 5);
        let before = snapshot(session.core());
        let log_len = session.edit_log().len();
        // M1 OBSERVED (guard deleted): this line panicked with
        //   `a pattern past MAX_ROUTE_EXPECT_BYTES is refused before any record exists:
        //    EditRecord { schema_version: 7, ..., op: Configure { ... Router { routes:
        //    [(RouteKey { offset: 0, expect: [0, 0, 0, ...] }, 0)] ... } } }`
        // The over-cap Configure was ACCEPTED and a full record was produced, which is
        // the defect verbatim: certified, foldable, savable, and unloadable.
        let err = session
            .apply(GridCommand::Configure {
                node: handle,
                config: wire_router_table(1, MAX_ROUTE_EXPECT_BYTES + 1),
            })
            .expect_err("a pattern past MAX_ROUTE_EXPECT_BYTES is refused before any record exists");
        assert_eq!(err, CommandError::OverLimit, "a pattern past its bound is OverLimit (plan 88-02)");
        // NOT merely "an Err came back": the refusal must leave the world untouched.
        assert_eq!(
            snapshot(session.core()),
            before,
            "reject leaves the core byte-identical (SC#2)"
        );
        assert_eq!(session.edit_log().len(), log_len, "reject appends no record");
    }

    #[test]
    fn configure_router_table_one_rule_over_the_cap_rejects_with_no_record() {
        let mut session = GridSession::new(3);
        let (_router, handle) = placed(&mut session, machine_kind::ROUTER, 5, 5);
        let before = snapshot(session.core());
        let log_len = session.edit_log().len();
        // M1 OBSERVED (guard deleted): this line panicked with
        //   `a table past MAX_ROUTES is refused before any record exists: EditRecord {
        //    schema_version: 7, ..., config: Router { routes: [(RouteKey { offset: 0,
        //    expect: [0] }, 0), (RouteKey { offset: 0, expect: [1] }, 0), ...] } }`
        let err = session
            .apply(GridCommand::Configure {
                node: handle,
                config: wire_router_table(MAX_ROUTES + 1, 1),
            })
            .expect_err("a table past MAX_ROUTES is refused before any record exists");
        assert_eq!(err, CommandError::OverLimit);
        assert_eq!(
            snapshot(session.core()),
            before,
            "reject leaves the core byte-identical (SC#2)"
        );
        assert_eq!(session.edit_log().len(), log_len, "reject appends no record");
    }

    #[test]
    fn configure_router_pattern_exactly_at_the_cap_is_accepted() {
        let mut session = GridSession::new(3);
        let (_router, handle) = placed(&mut session, machine_kind::ROUTER, 5, 5);
        let log_len = session.edit_log().len();
        // An off-by-one that refuses a LEGAL table is its own defect: `load_project`
        // admits exactly `<= cap`, so this table must be accepted here or the two
        // envelopes disagree in the other direction.
        session
            .apply(GridCommand::Configure {
                node: handle,
                config: wire_router_table(1, MAX_ROUTE_EXPECT_BYTES),
            })
            .expect("a pattern of exactly MAX_ROUTE_EXPECT_BYTES is legal");
        assert_eq!(session.edit_log().len(), log_len + 1, "it appends its record");
    }

    #[test]
    fn configure_router_table_exactly_at_the_cap_is_accepted() {
        let mut session = GridSession::new(3);
        let (_router, handle) = placed(&mut session, machine_kind::ROUTER, 5, 5);
        let log_len = session.edit_log().len();
        session
            .apply(GridCommand::Configure {
                node: handle,
                config: wire_router_table(MAX_ROUTES, 1),
            })
            .expect("a table of exactly MAX_ROUTES rules is legal");
        assert_eq!(session.edit_log().len(), log_len + 1, "it appends its record");
    }

    /// THE PROPERTY THAT ACTUALLY MATTERS: the write bound and the load bound agree.
    ///
    /// Nothing `validate_normalize` accepts may be refused on load, and nothing it
    /// refuses may be a table the loader would have taken. The old code violated the
    /// first half in the worst possible way: it accepted, certified and SAVED a table
    /// the loader then refused forever.
    #[test]
    fn command_accept_envelope_and_load_bound_agree_at_both_caps() {
        // Both dimensions, on both sides of both caps, all derived from the constants.
        let cases: [(usize, usize); 4] = [
            (1, MAX_ROUTE_EXPECT_BYTES),     // at the pattern cap: legal
            (1, MAX_ROUTE_EXPECT_BYTES + 1), // one byte over: the reported defect
            (MAX_ROUTES, 1),                 // at the table cap: legal
            (MAX_ROUTES + 1, 1),             // one rule over
        ];
        for (rules, expect_len) in cases {
            let mut session = GridSession::new(3);
            let (_router, handle) = placed(&mut session, machine_kind::ROUTER, 5, 5);
            let wire = wire_router_table(rules, expect_len);
            let core_shape = wire_config_to_core(wire.clone()).expect("a Router config converts");
            let admitted_on_load = load_bound_admits(&core_shape);
            let accepted = session
                .apply(GridCommand::Configure { node: handle, config: wire })
                .is_ok();
            // THE ASSERTION THAT REDDENS UNDER BOTH MUTATIONS. Observed:
            //   M1 (guard deleted):
            //     `the command layer and load_project disagree about rules=1
            //      expect_len=1025: command accepted=true, load admits=false`
            //     -- the reported defect stated as a one-line diff: the layer accepts
            //     what the loader refuses.
            //   M2 (`>` weakened to `>=`):
            //     `the command layer and load_project disagree about rules=1
            //      expect_len=1024: command accepted=false, load admits=true`
            //     -- the opposite defect: the layer refuses a table that loads fine.
            assert_eq!(
                accepted, admitted_on_load,
                "the command layer and load_project disagree about rules={rules} \
                 expect_len={expect_len}: command accepted={accepted}, \
                 load admits={admitted_on_load}",
            );
            if !accepted {
                continue;
            }
            // The executable second half. `edit::upcast` applies the IDENTICAL pair of
            // constants at the untrusted-decode boundary, so round-tripping the produced
            // record through the real on-disk postcard encoding proves the agreement
            // against shipped code rather than against a restated predicate.
            let record = session.edit_log().last().expect("an accepted Configure appended one");
            let bytes = postcard::to_allocvec(record).expect("an EditRecord postcard-encodes");
            fabrico_core::edit::upcast(&bytes, EDIT_SCHEMA_VERSION)
                .expect("a table the command layer accepted decodes at the trust boundary");
        }
    }

    // ────── BELT-04 (68-04): the 2..=20 pace bound, on WRITE and on write ONLY ──────
    //
    // The bound's reason is stated once, at the check itself in `wire_config_to_core`.
    // These cases assert what it DOES, and the load-side pair below asserts what it
    // deliberately does not do.

    /// The five paces the shipped panel offers (`D-68-02`, as amended). Named here so a
    /// reader can see that the accept envelope below is deliberately WIDER than this.
    const OFFERED_PACE_STEPS: [u32; 5] = [2, 4, 5, 10, 20];

    /// Every integer in `2..=20` that is NOT one of the five offered steps, ENUMERATED
    /// rather than sampled. A test exercising only the five steps is green under a
    /// five-values-only bound, and a five-values-only bound is the WRONG bound: it
    /// would refuse fourteen paces a save can legitimately carry (`D-68-02`, V14).
    const IN_RANGE_NON_STEPS: [u32; 14] =
        [3, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19];

    /// The four `ticks_per_slot` values the FROZEN scenario corpus uses, named in the
    /// source so a later reader can check the list against
    /// `crates/fabrico-scenario/tests/bless_fixtures.rs` (`FAST_TICKS_PER_SLOT` 3,
    /// `SLOW_TICKS_PER_SLOT` 9, `MEET_FAST_TICKS_PER_SLOT` 2, `MEET_SLOW_TICKS_PER_SLOT`
    /// 12). Every one of them must keep loading and replaying, or a shipped fixture
    /// becomes unloadable.
    const FROZEN_CORPUS_PACES: [u32; 4] = [3, 9, 2, 12];

    /// A belt's live `ticks_per_slot`, read off the folded core.
    fn belt_pace(session: &GridSession, id: NodeId) -> u32 {
        match session.core().state.node(id) {
            Some(Node::Belt(b)) => b.ticks_per_slot.get(),
            other => panic!("{id:?} is not a live belt: {other:?}"),
        }
    }

    /// Draw a two-tile belt and return `(NodeId, handle)`.
    fn belt(session: &mut GridSession, cells: Vec<(i32, i32)>) -> (NodeId, u64) {
        session
            .apply(GridCommand::DrawBelt { cells })
            .expect("a clear drawn path is accepted");
        let id = *session.core().last_tick.placed.last().expect("belt minted");
        let handle = session.view().handle_of(id).expect("the belt got a handle");
        (id, handle)
    }

    /// Apply `Configure{Belt{pace}}` to `handle` and hand back the outcome.
    fn set_pace(session: &mut GridSession, handle: u64, pace: u32) -> Result<(), CommandError> {
        session
            .apply(GridCommand::Configure {
                node: handle,
                config: fabrico_protocol::MachineConfig::Belt { ticks_per_slot: pace },
            })
            .map(|_| ())
    }

    /// Test 1: each of the five OFFERED steps is accepted on write and folds.
    #[test]
    fn every_offered_pace_step_is_accepted_on_write() {
        let mut session = GridSession::new(3);
        let (id, handle) = belt(&mut session, vec![(1, 0), (2, 0)]);
        for pace in OFFERED_PACE_STEPS {
            set_pace(&mut session, handle, pace)
                .unwrap_or_else(|e| panic!("the offered step {pace} must be accepted, got {e:?}"));
            assert_eq!(belt_pace(&session, id), pace, "the offered step {pace} folded");
        }
    }

    /// Test 2 (V14): every in-range integer that is NOT an offered step is accepted too.
    ///
    /// This is the case that separates the RIGHT bound from the plausible wrong one. A
    /// future UI with finer steps writes one of these fourteen into a save; a bound
    /// narrowed to the five offered values would refuse every one of them, and the
    /// five-step test above would stay green while it did.
    #[test]
    fn every_in_range_pace_that_is_not_an_offered_step_is_accepted_too() {
        let mut session = GridSession::new(3);
        let (id, handle) = belt(&mut session, vec![(1, 0), (2, 0)]);
        for pace in IN_RANGE_NON_STEPS {
            set_pace(&mut session, handle, pace)
                .unwrap_or_else(|e| panic!("in-range pace {pace} must be accepted, got {e:?}"));
            assert_eq!(belt_pace(&session, id), pace, "in-range pace {pace} folded");
        }
        // Anti-vacuity: the two lists together are exactly the inclusive range.
        let mut all: Vec<u32> = OFFERED_PACE_STEPS
            .iter()
            .chain(IN_RANGE_NON_STEPS.iter())
            .copied()
            .collect();
        all.sort_unstable();
        assert_eq!(
            all,
            (2..=20).collect::<Vec<u32>>(),
            "the offered steps plus the non-steps must BE the range 2..=20, or one of \
             the two lists has drifted and this file stops covering the bound",
        );
    }

    /// Test 3: `1` - the aliasing WALL itself - is refused with `PaceOutOfRange`, and
    /// this is the SC4 demonstration path from the shipped panel's typed pace field.
    #[test]
    fn the_wall_value_one_is_refused_with_pace_out_of_range() {
        let mut session = GridSession::new(3);
        let (id, handle) = belt(&mut session, vec![(1, 0), (2, 0)]);
        let before = belt_pace(&session, id);
        let log_len = session.edit_log().len();
        let core_before = snapshot(session.core());
        assert_eq!(
            set_pace(&mut session, handle, 1),
            Err(CommandError::PaceOutOfRange),
            "ticks_per_slot 1 is 8 world px per tick - EXACTLY the direction-ambiguity \
             wall - and is refused with its own typed tag, never ZeroBeltInterval",
        );
        assert_eq!(belt_pace(&session, id), before, "the refused write left the belt alone");
        assert_eq!(session.edit_log().len(), log_len, "the refusal appended NO record");
        assert_eq!(snapshot(session.core()), core_before, "state byte-identical (SC#2)");
    }

    /// Test 4: every value past the slow end is refused, including the extremes.
    #[test]
    fn every_pace_past_the_slow_end_is_refused_with_pace_out_of_range() {
        let mut session = GridSession::new(3);
        let (id, handle) = belt(&mut session, vec![(1, 0), (2, 0)]);
        let before = belt_pace(&session, id);
        for pace in [21u32, 100, 4096, u32::MAX] {
            assert_eq!(
                set_pace(&mut session, handle, pace),
                Err(CommandError::PaceOutOfRange),
                "pace {pace} is past the slow end and must be refused",
            );
            assert_eq!(belt_pace(&session, id), before, "pace {pace} left the belt alone");
        }
    }

    /// Test 5: `0` still lands on `ZeroBeltInterval`, not on the new tag.
    ///
    /// The two refusals must stay distinguishable, because each sentence is true of its
    /// OWN cause and false of the other's: "A belt needs a speed above zero." is false
    /// for someone who typed a large pace, and "That pace is outside the Belt pace
    /// scale." is a poor answer for a field left empty.
    #[test]
    fn a_zero_pace_still_lands_on_the_belt_interval_tag_and_not_the_new_one() {
        let mut session = GridSession::new(3);
        let (_id, handle) = belt(&mut session, vec![(1, 0), (2, 0)]);
        assert_eq!(
            set_pace(&mut session, handle, 0),
            Err(CommandError::ZeroBeltInterval),
            "zero is UNREPRESENTABLE in the core's NonZeroU32 and keeps its own tag",
        );
        assert_ne!(
            set_pace(&mut session, handle, 0),
            Err(CommandError::PaceOutOfRange),
            "the range bound must not swallow the zero case",
        );
    }

    /// Test 6 (`D-68-17`, THE SAVE-BREAKING ONE): a log carrying an out-of-range pace
    /// still LOADS and still REPLAYS - to the same state, not merely without an error.
    ///
    /// A load that silently substituted `DEFAULT_TICKS_PER_SLOT` also returns no error
    /// and produces a DIFFERENT board, so this asserts the replayed VALUE.
    ///
    /// MUTATION (recorded in `68-04-SUMMARY.md`): apply the same range check on the
    /// replay path and this reddens while tests 1 through 5 stay green. Without that,
    /// this case is satisfied by any build that never applies the bound anywhere.
    #[test]
    fn a_log_carrying_an_out_of_range_pace_still_loads_and_replays_to_the_same_state() {
        // 1 and 30 are on opposite sides of the bound, and neither is a corpus value.
        for out_of_range in [1u32, 30] {
            // Author the log the only way a WRITE-bounded layer can: build it in range,
            // then rewrite the folded record's value. That is exactly what an older
            // build, a hand-edited save, or a future UI with a different range produces.
            let mut donor = GridSession::new(3);
            let (_id, handle) = belt(&mut donor, vec![(1, 0), (2, 0)]);
            set_pace(&mut donor, handle, 7).expect("an in-range pace authors the record");
            let mut log = donor.edit_log().to_vec();
            let rewritten = log
                .iter_mut()
                .find_map(|r| match &mut r.op {
                    EditOp::Configure { config: MachineConfig::Belt { ticks_per_slot }, .. } => {
                        *ticks_per_slot = std::num::NonZeroU32::new(out_of_range)
                            .expect("the authored out-of-range value is non-zero");
                        Some(())
                    }
                    _ => None,
                })
                .is_some();
            assert!(rewritten, "the donor log carries exactly one Belt Configure to rewrite");

            // THE LOAD. `GridSession::replay` is the reconstruction primitive
            // `load_project` folds through, so a bound applied on load would bite here.
            let loaded = GridSession::replay(3, &log);
            let loaded_belt = loaded
                .core()
                .state
                .node_ids()
                .find(|id| matches!(loaded.core().state.node(*id), Some(Node::Belt(_))))
                .expect("the replayed core holds the belt - a load that REFUSED would not");
            assert_eq!(
                belt_pace(&loaded, loaded_belt),
                out_of_range,
                "the out-of-range pace {out_of_range} REPLAYED to the same value. A load \
                 that refused it, or one that silently substituted a default, both fail \
                 here - and the substituting one returns no error, which is why this \
                 asserts the STATE and not the Result",
            );
        }
    }

    /// Test 7: the four `ticks_per_slot` values the FROZEN scenario corpus uses all
    /// still load and replay. Three of the four are in range and would survive a bound
    /// applied anywhere; `3` is in range but is NOT an offered step, which is why test 2
    /// is not redundant with this one.
    #[test]
    fn every_frozen_corpus_pace_still_loads_and_replays() {
        for pace in FROZEN_CORPUS_PACES {
            let mut donor = GridSession::new(3);
            let (_id, handle) = belt(&mut donor, vec![(1, 0), (2, 0)]);
            set_pace(&mut donor, handle, pace)
                .unwrap_or_else(|e| panic!("corpus pace {pace} must be writable, got {e:?}"));
            let loaded = GridSession::replay(3, donor.edit_log());
            let loaded_belt = loaded
                .core()
                .state
                .node_ids()
                .find(|id| matches!(loaded.core().state.node(*id), Some(Node::Belt(_))))
                .expect("the replayed core holds the belt");
            assert_eq!(
                belt_pace(&loaded, loaded_belt),
                pace,
                "the frozen corpus value {pace} still replays to itself",
            );
        }
    }

    #[test]
    fn add_port_electrical_produces_the_first_design_time_wire_port() {
        let mut session = GridSession::new(3);
        // A Source (1x1, one Out) with room to grow east to (6,5).
        let (source, handle) = placed(&mut session, machine_kind::SOURCE, 5, 5);
        session
            .apply(GridCommand::AddPort {
                node: handle,
                role: port_role::IN,
                side: 3,
                medium: port_medium::ELECTRICAL,
            })
            .expect("AddPort Electrical accepted (PORT-06)");
        let ports = session.core().state.ports_of(source).expect("source now has ports");
        assert!(
            ports.iter().any(|p| p.medium == Medium::Electrical && p.role == Role::In),
            "AddPort with medium=Electrical produces a Medium::Electrical In port (PORT-06)",
        );
    }

    #[test]
    fn add_port_unknown_node_and_malformed_bytes_reject() {
        let mut session = GridSession::new(3);
        // Unknown handle -> UnknownNode.
        assert_eq!(
            session.apply(GridCommand::AddPort { node: 999, role: 0, side: 0, medium: 0 }),
            Err(CommandError::UnknownNode),
        );
        let (_router, handle) = placed(&mut session, machine_kind::ROUTER, 5, 5);
        // Unknown role byte / medium byte -> UnknownOption (typed, never a mis-cast).
        assert_eq!(
            session.apply(GridCommand::AddPort { node: handle, role: 9, side: 0, medium: 0 }),
            Err(CommandError::UnknownOption),
        );
        assert_eq!(
            session.apply(GridCommand::AddPort { node: handle, role: 0, side: 0, medium: 9 }),
            Err(CommandError::UnknownOption),
        );
    }

    // ─────────────── PORT-07 (36-02 Task 2): undo inverse pair + non-serialized capture ───────────────

    /// Issue an AddPort of an Out (Mechanical) to `handle`.
    fn add_out(session: &mut GridSession, handle: u64) {
        session
            .apply(GridCommand::AddPort {
                node: handle,
                role: port_role::OUT,
                side: 1,
                medium: port_medium::MECHANICAL,
            })
            .expect("AddPort Out accepted");
    }

    #[test]
    fn port_edit_add_then_undo_restores_prior_ports_and_footprint() {
        // A BALANCER's catalog ports ARE reseat-canonical ([In,In,Out,Out] at their
        // reseat_ports slots), so a port-edit's reseat is a no-op on the existing ports
        // and undo is byte-EXACT. (A ROUTER/Factory catalog seats a port off its reseat
        // slot — e.g. Router Out at (1,2) not (1,0) — so their first port-edit reseats
        // the pre-existing port; those restore the port SET+footprint, tested below.)
        let mut session = GridSession::new(9);
        let (bal, handle) = placed(&mut session, machine_kind::BALANCER, 5, 5);
        let ports0 = session.core().state.ports_of(bal).map(<[Port]>::to_vec);
        let fp0 = session.core().state.footprint_of(bal);

        add_out(&mut session, handle);
        assert_ne!(
            session.core().state.ports_of(bal).map(<[Port]>::to_vec),
            ports0,
            "AddPort changed the port list",
        );

        session.apply(GridCommand::Undo).expect("undo the AddPort");
        assert_eq!(
            session.core().state.ports_of(bal).map(<[Port]>::to_vec),
            ports0,
            "AddPort then Undo restores the prior port list byte-identically",
        );
        assert_eq!(
            session.core().state.footprint_of(bal),
            fp0,
            "AddPort then Undo restores the prior footprint byte-identically",
        );
    }

    #[test]
    fn port_edit_remove_last_then_undo_restores_exact_removed_port_and_footprint() {
        let mut session = GridSession::new(9);
        // BALANCER [In@0, In@1, Out@2, Out@3] — reseat-canonical; index 3 (the last Out)
        // is byte-exact to remove + undo (append restores the canonical order).
        let (bal, handle) = placed(&mut session, machine_kind::BALANCER, 5, 5);
        let ports0 = session.core().state.ports_of(bal).map(<[Port]>::to_vec);
        let fp0 = session.core().state.footprint_of(bal);
        let removed = session.core().state.ports_of(bal).unwrap()[3];
        assert_eq!(removed.role, Role::Out, "index 3 is the last Out port");

        session
            .apply(GridCommand::RemovePort { node: handle, index: 3 })
            .expect("RemovePort the last Out");
        assert_eq!(
            session.core().state.ports_of(bal).map(<[Port]>::to_vec).unwrap().len(),
            3,
            "one port gone after RemovePort",
        );

        session.apply(GridCommand::Undo).expect("undo the RemovePort");
        // The EXACT removed port (role+medium) is recovered from the non-serialized capture.
        let restored = session.core().state.ports_of(bal).map(<[Port]>::to_vec);
        assert_eq!(restored, ports0, "Undo restores the exact prior port list (removed the LAST port)");
        assert!(
            restored.unwrap().iter().any(|p| p.role == removed.role && p.medium == removed.medium),
            "the EXACT removed port (role+medium) is recovered",
        );
        assert_eq!(session.core().state.footprint_of(bal), fp0, "footprint restored");
    }

    #[test]
    fn port_edit_remove_middle_undo_restores_set_and_footprint() {
        // A NON-last removal: undo re-APPENDS the captured port, so the port SET +
        // footprint are restored exactly (grow_to_fit counts roles only), even though a
        // same-role sibling may re-seat to a different slot (the append-inverse design).
        let mut session = GridSession::new(9);
        let (router, handle) = placed(&mut session, machine_kind::ROUTER, 5, 5);
        add_out(&mut session, handle); // ports: [In, Out, Out] (2x3)
        let fp0 = session.core().state.footprint_of(router);
        let mut roles0: Vec<Role> =
            session.core().state.ports_of(router).unwrap().iter().map(|p| p.role).collect();
        roles0.sort_unstable_by_key(|r| *r as u8);

        session
            .apply(GridCommand::RemovePort { node: handle, index: 1 }) // remove the FIRST Out (middle)
            .expect("RemovePort middle");
        session.apply(GridCommand::Undo).expect("undo the RemovePort");

        let mut roles1: Vec<Role> =
            session.core().state.ports_of(router).unwrap().iter().map(|p| p.role).collect();
        roles1.sort_unstable_by_key(|r| *r as u8);
        assert_eq!(roles1, roles0, "the port role multiset is restored");
        assert_eq!(session.core().state.footprint_of(router), fp0, "the footprint is restored");
    }

    #[test]
    fn port_edit_add_then_remove_and_remove_then_add_replay_byte_identical() {
        // add-then-remove.
        let mut a = GridSession::new(11);
        let (_ra, ha) = placed(&mut a, machine_kind::ROUTER, 5, 5);
        add_out(&mut a, ha);
        a.apply(GridCommand::RemovePort { node: ha, index: 2 }).expect("remove the just-added Out");
        assert_eq!(
            snapshot(a.core()),
            snapshot(GridSession::replay(11, a.edit_log()).core()),
            "add-then-remove replays byte-identically",
        );
        // remove-then-add.
        let mut b = GridSession::new(11);
        let (_rb, hb) = placed(&mut b, machine_kind::ROUTER, 5, 5);
        b.apply(GridCommand::RemovePort { node: hb, index: 1 }).expect("remove the Out");
        add_out(&mut b, hb);
        assert_eq!(
            snapshot(b.core()),
            snapshot(GridSession::replay(11, b.edit_log()).core()),
            "remove-then-add replays byte-identically",
        );
    }

    #[test]
    fn port_edit_replay_of_log_with_addport_removeport_undo_is_byte_equal() {
        // A log that ALREADY contains AddPort + RemovePort + Undo reconstructs a
        // byte-equal core (the undo's resolved inverse is a stored record) AND an
        // equivalent projection (can_undo/can_redo) — with NO serialized capture field.
        let mut session = GridSession::new(13);
        let (_router, handle) = placed(&mut session, machine_kind::ROUTER, 5, 5);
        add_out(&mut session, handle);
        session.apply(GridCommand::RemovePort { node: handle, index: 1 }).expect("remove");
        session.apply(GridCommand::Undo).expect("undo the remove");

        let replayed = GridSession::replay(13, session.edit_log());
        assert_eq!(
            snapshot(session.core()),
            snapshot(replayed.core()),
            "replay of a port-edit+undo log rebuilds a byte-equal core (no serialized capture)",
        );
        assert_eq!(replayed.can_undo(), session.can_undo(), "projection can_undo matches");
        assert_eq!(replayed.can_redo(), session.can_redo(), "projection can_redo matches");
    }

    #[test]
    fn port_edit_undo_of_removeport_survives_save_load_with_zero_serialized_capture() {
        // The durability crux: a saved log that ends at a RemovePort (its undo NOT yet
        // issued) is reconstructed; issuing Undo on the RECONSTRUCTED session must
        // recover the EXACT removed port from the re-folded `removed_ports` side-table
        // (rebuilt purely from the log — nothing serialized carries the removed port).
        let mut live = GridSession::new(17);
        // BALANCER (reseat-canonical) removing its LAST Out (index 3) so undo is byte-exact.
        let (bal_live, handle) = placed(&mut live, machine_kind::BALANCER, 5, 5);
        let ports0 = live.core().state.ports_of(bal_live).map(<[Port]>::to_vec);
        live.apply(GridCommand::RemovePort { node: handle, index: 3 }).expect("remove the last Out");

        // Save -> load (reconstruct from the persisted edit-log only).
        let mut loaded = GridSession::replay(17, live.edit_log());
        // The reconstructed session must still know an undo is available and, crucially,
        // recover the removed port with NO serialized capture.
        assert!(loaded.can_undo(), "the reconstructed session can still undo the remove");
        loaded.apply(GridCommand::Undo).expect("undo on the reconstructed session");

        // Resolve the machine in the reconstructed core (same seed -> same NodeId).
        let bal_loaded = loaded.core().state.occupied((5, 5)).expect("balancer anchor occupied");
        assert_eq!(
            loaded.core().state.ports_of(bal_loaded).map(<[Port]>::to_vec),
            ports0,
            "Undo after save/load restores the EXACT removed port from the rebuilt capture",
        );
    }

    #[test]
    fn port_edit_add_undo_redo_and_remove_undo_redo_reapply() {
        // AddPort -> Undo -> Redo re-adds the port.
        let mut session = GridSession::new(19);
        let (router, handle) = placed(&mut session, machine_kind::ROUTER, 5, 5);
        let with_extra = {
            add_out(&mut session, handle);
            session.core().state.ports_of(router).map(<[Port]>::to_vec)
        };
        session.apply(GridCommand::Undo).expect("undo add");
        session.apply(GridCommand::Redo).expect("redo add");
        assert_eq!(
            session.core().state.ports_of(router).map(<[Port]>::to_vec),
            with_extra,
            "Redo re-applies the AddPort",
        );

        // RemovePort -> Undo -> Redo re-removes the port.
        //
        // THE INDEX IS DERIVED, and phase 71 is why. It was the literal `2` with the
        // comment "remove last Out", which was true of the pre-PILE-10 catalog and is not
        // true of any catalog after it: the appended `Role::Fault` nub (plus the AddPort
        // above) makes index 2 a MIDDLE port. That matters because this repository
        // already knows removing a middle port is not byte-exact under undo - the sibling
        // test `port_edit_undo_of_removeport_survives_save_load_with_zero_serialized_capture`
        // says so in its own words, "removing its LAST Out (index 3) so undo is
        // byte-exact", because `reseat_ports` re-canonicalises the offsets of everything
        // after the hole. So the literal did not merely go stale; it silently changed
        // WHICH property this test measures.
        //
        // Reading the position off the live port list keeps it measuring the one it was
        // written for, and cannot rot again the next time an arm is widened.
        let last_out = session
            .core()
            .state
            .ports_of(router)
            .expect("a placed router has ports")
            .iter()
            .rposition(|p| p.role == Role::Out)
            .expect("a router always has at least one Out");
        let before_remove = session.core().state.ports_of(router).map(<[Port]>::to_vec);
        session
            .apply(GridCommand::RemovePort { node: handle, index: last_out as u16 })
            .expect("remove the LAST Out");
        let after_remove = session.core().state.ports_of(router).map(<[Port]>::to_vec);
        session.apply(GridCommand::Undo).expect("undo remove");
        assert_eq!(
            session.core().state.ports_of(router).map(<[Port]>::to_vec),
            before_remove,
            "Undo restores the removed port",
        );
        session.apply(GridCommand::Redo).expect("redo remove");
        assert_eq!(
            session.core().state.ports_of(router).map(<[Port]>::to_vec),
            after_remove,
            "Redo re-applies the RemovePort",
        );
    }

    // ─────────────────── FOOT-05: node-stored footprints, dims unchanged (35-04) ───────────────────
    //
    // FOOT-05 holds against the CURRENT model with ZERO production change (RESEARCH Q1):
    // operator dims are node-stored (`GridState.footprints`/`ports`, the Phase-36
    // mutation target) and UNCHANGED from v5.0 — no second footprint store is built.

    #[test]
    fn foot05_operator_dims_unchanged_from_v5() {
        // The authoritative operator dims are `port_catalog`'s (the seed the fold
        // freezes into `EditOp::Place` and the placed node's `footprints` entry). No
        // visual resize this phase — every dim is the v5.0 value.
        let dims = |k| {
            let (f, _) = port_catalog(k);
            (f.w, f.h)
        };
        assert_eq!(dims(machine_kind::SOURCE), (1, 1), "Source stays 1x1");
        assert_eq!(dims(machine_kind::SINK), (1, 1), "Sink stays 1x1");
        assert_eq!(dims(machine_kind::TEE), (2, 2), "Tee stays 2x2");
        assert_eq!(dims(machine_kind::BALANCER), (2, 2), "Balancer stays 2x2");
        assert_eq!(dims(machine_kind::MERGE), (2, 2), "Merge stays 2x2");
        assert_eq!(dims(machine_kind::ROUTER), (2, 3), "Router stays 2x3");
        assert_eq!(dims(machine_kind::FACTORY), (3, 3), "Factory stays 3x3");
    }

    #[test]
    fn foot05_multicell_node_stored_survives_round_trip_1x1_footprint_absent() {
        use fabrico_core::snapshot::restore;
        // A multi-cell operator writes a `footprints` + `ports` entry into GridState
        // (the node-stored resize surface, NOT a static catalog derive); a 1x1
        // Source/Sink writes NO `footprints` entry (absent ⇒ 1x1 rot0). Both survive
        // snapshot -> restore byte-identically (the already-trust-gated substrate).
        let mut session = GridSession::new(7);
        // Router 2x3 (multi-cell) at (0,0); a Source 1x1 well clear at (5,5).
        session
            .apply(GridCommand::Place { kind: machine_kind::ROUTER, cell_x: 0, cell_y: 0 })
            .expect("router placed");
        let router = *session.core().last_tick.placed.last().expect("router minted");
        session
            .apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 5, cell_y: 5 })
            .expect("source placed");
        let source = *session.core().last_tick.placed.last().expect("source minted");

        // Node-stored: the router's 2x3 footprint + ports live in GridState.
        assert_eq!(
            session.core().state.footprint_of(router),
            Some(Footprint { w: 2, h: 3, rot: 0 }),
            "the multi-cell router's footprint is node-stored",
        );
        assert!(
            session.core().state.ports_of(router).is_some(),
            "the router's ports are node-stored (the Phase-36 mutation target)",
        );
        // A 1x1 Source writes NO `footprints` entry (absent ⇒ 1x1 rot0).
        assert!(
            session
                .core()
                .state
                .footprints_iter()
                .all(|(id, _)| id != source),
            "a 1x1 Source writes no footprints entry (absent ⇒ 1x1 rot0)",
        );
        assert_eq!(
            session.core().state.footprint_of(source),
            None,
            "footprint_of a 1x1 Source is absent (the faithful default, no stored dims)",
        );

        // The node-stored footprint + ports survive snapshot -> restore byte-identically.
        let bytes = snapshot(session.core());
        let restored = restore(&bytes).expect("the placed grid restores through the trust gate");
        assert_eq!(
            bytes,
            snapshot(&restored),
            "node-stored footprints/ports round-trip byte-identically (no second store)",
        );
        assert_eq!(
            restored.state.footprint_of(router),
            Some(Footprint { w: 2, h: 3, rot: 0 }),
            "the router's stored dims survive restore unchanged",
        );
    }

    #[test]
    fn foot05_port_medium_is_reachable_place_snapshot_restore_and_catalog_view() {
        use fabrico_core::snapshot::restore;
        // (a) Round-trip: a non-default `Electrical` medium on a placed machine's
        //     node-stored port survives Place -> snapshot -> restore (the new v6.0
        //     field is real, reachable state — not a dead schema slot).
        let mut session = GridSession::new(7);
        session
            .apply(GridCommand::Place { kind: machine_kind::ROUTER, cell_x: 0, cell_y: 0 })
            .expect("router placed");
        let router = *session.core().last_tick.placed.last().expect("router minted");
        let mut ports = session
            .core()
            .state
            .ports_of(router)
            .expect("the router's ports are node-stored")
            .to_vec();
        ports[0].medium = Medium::Electrical; // the WIRE seam's non-default medium
        session.core_mut().state.set_ports(router, ports);
        let bytes = snapshot(session.core());
        let restored = restore(&bytes).expect("a router with an Electrical port restores");
        assert_eq!(
            restored
                .state
                .ports_of(router)
                .expect("ports survive restore")[0]
                .medium,
            Medium::Electrical,
            "a non-default Port.medium round-trips Place -> snapshot -> restore",
        );

        // (b) View surface: the catalog -> `CatalogPortView` path carries the medium
        //     byte (`catalog_medium_u8` is its SOLE producer). Every catalog kind is
        //     Mechanical today, and the Electrical mapping is wired through — so the
        //     field reaches the exported view surface, not just core state.
        let e = catalog_entry(machine_kind::ROUTER);
        assert!(
            e.ports.iter().all(|p| p.medium == port_medium::MECHANICAL),
            "catalog ports surface their medium byte (Mechanical today)",
        );
        assert_eq!(
            catalog_medium_u8(Medium::Electrical),
            port_medium::ELECTRICAL,
            "the Electrical medium is wired through the catalog -> PortView surface",
        );
        assert_eq!(catalog_medium_u8(Medium::Mechanical), port_medium::MECHANICAL);
    }

    #[test]
    fn catalog_entry_factory_is_sourced_from_port_catalog_fault_at_index_2() {
        let e = catalog_entry(machine_kind::FACTORY);
        assert_eq!(e.kind, machine_kind::FACTORY);
        assert_eq!((e.w, e.h, e.rot), (3, 3, 0), "FACTORY ghost is 3x3 rot0");
        assert_eq!(e.ports.len(), 3, "In + Out + Fault");
        // In / Out / Fault carried in port-index order, rot-0 local offsets.
        assert_eq!(e.ports[0].role, port_role::IN);
        assert_eq!((e.ports[0].local_x, e.ports[0].local_y, e.ports[0].side), (0, 1, 3 /*W*/));
        assert_eq!(e.ports[1].role, port_role::OUT);
        assert_eq!((e.ports[1].local_x, e.ports[1].local_y, e.ports[1].side), (2, 1, 1 /*E*/));
        // Fault present at index 2, S-center — the reconciliation the ghost renders.
        assert_eq!(e.ports[2].role, port_role::FAULT);
        assert_eq!((e.ports[2].local_x, e.ports[2].local_y, e.ports[2].side), (1, 2, 2 /*S*/));

        // Single source of truth: the exported entry is a faithful map of
        // port_catalog — NOT a second hand-maintained constant (T-17-CAT-DRIFT).
        let (foot, ports) = port_catalog(machine_kind::FACTORY);
        assert_eq!((e.w, e.h, e.rot), (foot.w, foot.h, foot.rot));
        assert_eq!(e.ports.len(), ports.len());
        for (cp, p) in e.ports.iter().zip(ports.iter()) {
            assert_eq!(cp.local_x, p.local_offset.0);
            assert_eq!(cp.local_y, p.local_offset.1);
            assert_eq!(cp.side, catalog_side_u8(p.side));
            assert_eq!(cp.role, catalog_role_u8(p.role));
        }
    }

    #[test]
    fn catalog_entry_covers_every_kind_from_port_catalog() {
        // Every non-BELT kind produces an entry whose footprint + port count match
        // port_catalog exactly (single source), for all kinds the ghost may preview.
        for kind in CATALOG_KINDS {
            let e = catalog_entry(kind);
            let (foot, ports) = port_catalog(kind);
            assert_eq!((e.w, e.h), (foot.w, foot.h), "kind {kind} footprint matches");
            assert_eq!(e.ports.len(), ports.len(), "kind {kind} port count matches");
        }
    }

    #[test]
    fn port_catalog_every_footprint_cell_is_in_bounds_at_origin() {
        // Sanity: no kind resolves a degenerate 0-dim footprint.
        for kind in CATALOG_KINDS {
            let (foot, _) = port_catalog(kind);
            assert!(foot.w >= 1 && foot.h >= 1, "kind {kind} has a real footprint");
        }
    }

    // ───────────────────── the retained effect buffer (63-08, WIRE-04) ─────────────────────

    /// Build a source -> 4-tile belt -> sink chain and return `(session, source_id)`.
    fn effect_chain() -> (GridSession, NodeId) {
        let mut session = GridSession::new(0xEFFEC7);
        let place = |session: &mut GridSession, kind: u8, x: i32, y: i32| -> u64 {
            session
                .apply(GridCommand::Place { kind, cell_x: x, cell_y: y })
                .expect("place accepted");
            let id = *session.core().last_tick.placed.last().expect("minted");
            session.view().handle_of(id).expect("handle")
        };
        let src = place(&mut session, machine_kind::SOURCE, 0, 0);
        let sink = place(&mut session, machine_kind::SINK, 5, 0);
        session
            .apply(GridCommand::DrawBelt { cells: vec![(1, 0), (2, 0), (3, 0), (4, 0)] })
            .expect("belt accepted");
        let belt_id = *session.core().last_tick.placed.last().expect("belt minted");
        let belt = session.view().handle_of(belt_id).expect("belt handle");
        session
            .apply(GridCommand::Dock { belt, endpoint: fabrico_protocol::BeltEnd::Tail, node: src, port: 0 })
            .expect("tail dock accepted");
        session
            .apply(GridCommand::Dock { belt, endpoint: fabrico_protocol::BeltEnd::Head, node: sink, port: 0 })
            .expect("head dock accepted");
        let src_id = session.view().lookup(session.core()).resolve(src).expect("source id");
        (session, src_id)
    }

    /// One `ManualInject` stamped by the session (`pump` overwrites the provenance).
    fn inject(target: NodeId, byte: u8) -> Event {
        Event {
            schema_version: SCHEMA_VERSION,
            partition: 0,
            sequence: 0,
            tick: 0,
            payload: fabrico_core::event::EventPayload::ManualInject {
                target,
                port: 0,
                item: fabrico_core::ids::Item(vec![byte]),
            },
        }
    }

    #[test]
    fn effects_accumulate_across_folds_and_drain_clears() {
        // The property `Scene::drain_effects` rests on. `advance(n)` folds ONE tick per
        // iteration, so a buffer that ASSIGNED rather than appended would report the
        // final idle tick's effects — empty. The item below reaches the sink early and
        // the sink emits its Debug effect THERE.
        let (mut session, src_id) = effect_chain();
        session.pump(&[inject(src_id, 0xA5)]);
        session.advance(64 * u64::from(fabrico_core::belt_slots::DEFAULT_TICKS_PER_SLOT.get()));

        let drained = session.drain_effects();
        assert!(
            drained
                .iter()
                .any(|c| c.effect == fabrico_core::command::Effect::Debug { message: vec![0xA5] }),
            "an effect emitted mid-settle survives to the drain: got {drained:?}",
        );
        assert!(
            session.drain_effects().is_empty(),
            "draining CLEARS: a second drain with no intervening fold returns nothing",
        );
    }

    #[test]
    fn fold_live_does_not_double_book_the_buffer() {
        // `fold_live` RETURNS its commands to the live host, which consumes them. It is
        // therefore the one seam that deliberately does NOT retain: a second copy would
        // double-book every dispatched effect and, since the host never drains, grow
        // without bound for as long as the app runs.
        let (mut session, src_id) = effect_chain();
        let _ = session.drain_effects();
        let returned = session.fold_live(&[], &[inject(src_id, 0xA5)]);
        assert!(returned.is_empty(), "the inject tick itself emits nothing");
        assert!(
            session.drain_effects().is_empty(),
            "fold_live retained nothing — its caller already owns the commands",
        );
    }

    #[test]
    fn the_effect_buffer_is_not_serialized_state() {
        // T-63-63: draining must move no snapshot byte and no edit-log byte. If the
        // buffer ever reached serialized state this is the test that says so.
        let build = |drain: bool| {
            let (mut session, src_id) = effect_chain();
            session.pump(&[inject(src_id, 0xA5)]);
            session.advance(16);
            if drain {
                let _ = session.drain_effects();
            }
            session.advance(16);
            (
                snapshot(session.core()),
                postcard::to_allocvec(session.edit_log()).expect("encode"),
            )
        };
        assert_eq!(build(true), build(false), "draining changes no serialized byte");
    }

    use crate::grid_view::GridView;

    fn header() -> LogHeader {
        LogHeader {
            schema_version: SCHEMA_VERSION,
            seed: 7,
        }
    }

    /// A resolved edit-record placing `kind`, stamped at `tick` (the view-building
    /// helper folds it via the edit-log path, exactly as the session does).
    fn edit_place(kind: u8, seq: u64, tick: u64) -> EditRecord {
        EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: seq,
            tick,
            action: 0,
            op: EditOp::Place {
                kind,
                cell_x: 0,
                cell_y: 0,
                w: 1,
                h: 1,
                ports: vec![],
                rot: 0,
            },
        }
    }

    /// Build a `GridView` with `n` Source nodes placed at distinct cells, folding
    /// each through the edit-log path (one record per tick) and projecting it into
    /// the view — exactly how `GridSession` builds the view. Returns the view, the
    /// minted `NodeId`s, and their dense handles (handle `i` == the i-th placed id).
    /// The ONE resolved [`EditOp`] of a group that must hold exactly one record.
    ///
    /// Since 72-08 [`validate_normalize`] answers a GROUP, because a drag between a Route
    /// and a Handler resolves to two records under one action id. Every OTHER command
    /// resolves to exactly one, and these assertions say that out loud rather than
    /// indexing `[0]` and quietly passing if a second record appeared.
    fn only_op(group: &[EditRecord]) -> EditOp {
        assert_eq!(
            group.len(),
            1,
            "this command resolves to exactly ONE record; the paired arms are the only \
             ones that resolve to two"
        );
        group[0].op.clone()
    }

    fn view_with_sources(n: usize) -> (GridView, Core, Vec<NodeId>, Vec<u64>) {
        let mut core = Core::genesis(header());
        let mut view = GridView::new();
        let mut ids = Vec::new();
        let mut handles = Vec::new();
        for i in 0..n {
            let tick = core.tick;
            let cell = (i as i32, 0);
            let rec = EditRecord {
                op: EditOp::Place {
                    kind: machine_kind::SOURCE,
                    cell_x: cell.0,
                    cell_y: cell.1,
                    w: 1,
                    h: 1,
                    ports: vec![],
                    rot: 0,
                },
                tick,
                ..edit_place(machine_kind::SOURCE, i as u64, tick)
            };
            core.advance_edits(std::slice::from_ref(&rec), &[]);
            view.apply_tick(&core);
            let id = *core.last_tick.placed.last().expect("a node was minted");
            ids.push(id);
            handles.push(view.handle_of(id).expect("the minted node got a handle"));
        }
        (view, core, ids, handles)
    }

    #[test]
    fn place_on_free_cell_produces_place_record() {
        let core = Core::genesis(header());
        let view = GridView::new();
        let rec = validate_normalize(
            &view.lookup(&core),
            GridCommand::Place {
                kind: machine_kind::FACTORY,
                cell_x: 3,
                cell_y: -4,
            },
        )
        .expect("a free in-bounds place is accepted");
        // 17-01: validate_normalize now freezes the RESOLVED catalog footprint+ports
        // (FACTORY is a real 3×3 with In/Out/Fault), not the old 1×1 default. Assert
        // against port_catalog (the single source of truth) so this can't drift.
        let (fp, ports) = port_catalog(machine_kind::FACTORY);
        assert_eq!((fp.w, fp.h), (3, 3), "FACTORY resolves to the 3×3 catalog footprint");
        assert_eq!(
            only_op(&rec),
            EditOp::Place {
                kind: machine_kind::FACTORY,
                cell_x: 3,
                cell_y: -4,
                w: fp.w,
                h: fp.h,
                ports,
                rot: 0,
            }
        );
    }

    #[test]
    fn place_on_occupied_cell_is_rejected_and_produces_nothing() {
        // (5, 0) is occupied by the first source (view_with_sources places at (i,0)).
        // A 1×1 machine is a single-cell footprint, so a same-cell collision surfaces
        // as FootprintCollision (the v1.0 Occupied generalized into the loop).
        let (view, core, _ids, _h) = view_with_sources(6);
        let result = validate_normalize(
            &view.lookup(&core),
            GridCommand::Place {
                kind: machine_kind::SOURCE,
                cell_x: 5,
                cell_y: 0,
            },
        );
        assert_eq!(result, Err(CommandError::FootprintCollision));
    }

    #[test]
    fn place_out_of_bounds_is_rejected() {
        let core = Core::genesis(header());
        let view = GridView::new();
        assert_eq!(
            validate_normalize(
                &view.lookup(&core),
                GridCommand::Place {
                    kind: machine_kind::SOURCE,
                    cell_x: i32::MAX,
                    cell_y: 0,
                },
            ),
            Err(CommandError::OutOfBounds)
        );
        // Just past the bound on the low axis is also rejected.
        assert_eq!(
            validate_normalize(
                &view.lookup(&core),
                GridCommand::Place {
                    kind: machine_kind::SOURCE,
                    cell_x: 0,
                    cell_y: GRID_MIN - 1,
                },
            ),
            Err(CommandError::OutOfBounds)
        );
    }

    #[test]
    fn place_unknown_kind_is_rejected() {
        let core = Core::genesis(header());
        let view = GridView::new();
        assert_eq!(
            validate_normalize(
                &view.lookup(&core),
                GridCommand::Place {
                    kind: 250,
                    cell_x: 0,
                    cell_y: 0,
                },
            ),
            Err(CommandError::UnknownKind)
        );
        // WIRE (8) sits BETWEEN SINK (7) and ENDPOINT (9) and is refused, which is the
        // whole reason the gate is an allow-set. This assertion used to read
        // `machine_kind::SINK + 1` and pass for a different reason: it was the byte one
        // past the ceiling. It is spelled by name now so it keeps meaning what it says.
        assert_eq!(
            validate_normalize(
                &view.lookup(&core),
                GridCommand::Place {
                    kind: machine_kind::WIRE,
                    cell_x: 0,
                    cell_y: 0,
                },
            ),
            Err(CommandError::UnknownKind)
        );
        // The byte one past LABEL, the highest kind that names anything placeable.
        // It read `ENDPOINT + 1` until 72-05 minted HANDLER at that byte, and
        // `HANDLER + 1` until phase 76 minted LABEL at byte 11; it is spelled against the
        // CURRENT ceiling so it keeps meaning "one past the top" rather than quietly
        // becoming an assertion about a real, placeable kind.
        assert_eq!(
            validate_normalize(
                &view.lookup(&core),
                GridCommand::Place {
                    kind: machine_kind::LABEL + 1,
                    cell_x: 0,
                    cell_y: 0,
                },
            ),
            Err(CommandError::UnknownKind)
        );
    }

    // 17-02: the node→node Wire tests (wire_between_two_resolved_handles,
    // wire_with_unknown_handle_is_rejected, wire_self_loop_is_rejected) were deleted
    // with the GridCommand::Wire / EditOp::Wire variants. Belt topology is now built
    // by DrawBelt + Dock; those paths are covered by the dock_* / drawbelt_* tests
    // below and rebuilt into the command-built corpus in 17-06.

    #[test]
    fn reject_place_belt_is_typed_error_before_catalog() {
        // 17-02 (CAT-04 / CLEAN-06): a Place whose kind is BELT is rejected with the
        // typed CommandError::BeltNotPlaceable BEFORE catalog resolution — belts come
        // only from DrawBelt + Dock, never minted via Place (the fold_place BELT arm is
        // gone). A reject produces NOTHING (SC#2): never a panic, never a silent mint.
        let core = Core::genesis(header());
        let view = GridView::new();
        assert_eq!(
            validate_normalize(
                &view.lookup(&core),
                GridCommand::Place {
                    kind: machine_kind::BELT,
                    cell_x: 0,
                    cell_y: 0,
                },
            ),
            Err(CommandError::BeltNotPlaceable),
            "Place{{kind=BELT}} is a typed reject (belts come only from DrawBelt)"
        );
    }

    #[test]
    fn delete_resolved_handle_captures_kind_and_cell() {
        let (view, core, ids, handles) = view_with_sources(1);
        let rec = validate_normalize(&view.lookup(&core), GridCommand::Delete { node: handles[0] })
            .expect("deleting a live node is accepted");
        assert_eq!(
            only_op(&rec),
            EditOp::Delete {
                node: ids[0],
                kind: machine_kind::SOURCE,
                cell_x: 0, // view_with_sources placed the first source at (0, 0)
                cell_y: 0,
                captured: DeletedSubgraph::default(),
            },
            "Delete captures the resolved kind + cell at delete time (FORK 1)"
        );
    }

    #[test]
    fn delete_unknown_handle_is_rejected() {
        let core = Core::genesis(header());
        let view = GridView::new();
        assert_eq!(
            validate_normalize(&view.lookup(&core), GridCommand::Delete { node: 7 }),
            Err(CommandError::UnknownNode)
        );
    }

    // 17-02: rewire_occupied_output_port_is_rejected tested the node→node Wire
    // re-wire guard (WR-04), which was removed with GridCommand::Wire. Belts now dock
    // via Dock (whose link legality is covered by the dock_* tests below).

    /// Place the multi-cell exemplar (ROUTER) and return its dense handle.
    fn place_exemplar(session: &mut GridSession, cell_x: i32, cell_y: i32) -> u64 {
        session
            .apply(GridCommand::Place {
                kind: machine_kind::ROUTER,
                cell_x,
                cell_y,
            })
            .expect("the multi-cell exemplar is placed");
        let id = *session.core().last_tick.placed.last().expect("router minted");
        session.view().handle_of(id).expect("router got a handle")
    }

    #[test]
    fn footprint_collision_is_atomic_and_bounds_checks_every_cell() {
        // FOOT-01: the multi-cell exemplar resolves to a 2×3 footprint; placement is
        // collision- AND bounds-checked over EVERY cell, and rejected atomically (the
        // whole placement produces nothing, state byte-identical) on the first bad
        // cell — never partial, never an eviction.
        let mut session = GridSession::new(7);
        // ROUTER -> 2×3 at (0,0): occupies x∈{0,1}, y∈{0,1,2}.
        place_exemplar(&mut session, 0, 0);
        let before = snapshot(session.core());

        // (a) A 1×1 place onto a NON-anchor body cell of the footprint collides.
        assert_eq!(
            session
                .apply(GridCommand::Place {
                    kind: machine_kind::SOURCE,
                    cell_x: 1,
                    cell_y: 1,
                })
                .err(),
            Some(CommandError::FootprintCollision),
            "a 1×1 place onto a multi-cell body cell collides"
        );
        // (b) A multi-cell place whose ANCHOR is free but whose body overlaps on a
        //     non-anchor cell rejects the WHOLE placement (atomic). Anchor (-1, 1) is
        //     free; body cells (0,1),(0,2) overlap the first router.
        assert_eq!(
            session
                .apply(GridCommand::Place {
                    kind: machine_kind::ROUTER,
                    cell_x: -1,
                    cell_y: 1,
                })
                .err(),
            Some(CommandError::FootprintCollision),
            "a non-anchor body overlap rejects the entire placement atomically"
        );
        // (c) Pitfall 5: every footprint cell is bounds-checked, not just the anchor.
        //     A 2×3 anchored AT the max bound spills its body off-grid -> OutOfBounds.
        assert_eq!(
            session
                .apply(GridCommand::Place {
                    kind: machine_kind::ROUTER,
                    cell_x: GRID_MAX,
                    cell_y: 0,
                })
                .err(),
            Some(CommandError::OutOfBounds),
            "a body cell past GRID_MAX is rejected even with an in-bounds anchor"
        );
        // Every reject produced NOTHING: the core is byte-identical (SC#2).
        assert_eq!(
            snapshot(session.core()),
            before,
            "the rejected placements leave the Core byte-identical"
        );
    }

    #[test]
    fn move_is_delete_place() {
        // Move = Delete + Place under ONE shared action id (no EditOp::Move): the
        // delete frees the old footprint (+ cascade-detaches docked belts, FOOT-04),
        // the place re-claims the new footprint, and BOTH records carry the same
        // action (Phase-12 coalescing groundwork). Move the 2×3 exemplar from (0,0)
        // to (10,10).
        let mut session = GridSession::new(7);
        let handle = place_exemplar(&mut session, 0, 0);
        // The old 2×3 footprint is claimed before the move.
        for c in cells_of_footprint((0, 0), 2, 3, 0) {
            assert!(session.core().state.occupied(c).is_some(), "old footprint claimed");
        }

        session
            .move_machine(handle, machine_kind::ROUTER, 10, 10)
            .expect("the exemplar moves to a free region");

        // The move appended exactly two records (a Delete then a Place), sharing one
        // action id (no increment between the pair) — Phase-12 coalescing groundwork.
        let log = session.edit_log();
        let place = log.last().expect("place record");
        let delete = &log[log.len() - 2];
        assert!(matches!(delete.op, EditOp::Delete { .. }), "first move record is a Delete");
        assert!(matches!(place.op, EditOp::Place { .. }), "second move record is a Place");
        assert_eq!(
            delete.action, place.action,
            "Delete + Place share ONE action id (Move = delete+place under one action)"
        );

        // Free-then-reclaim: the OLD footprint cells are freed, the NEW footprint
        // cells are claimed.
        for c in cells_of_footprint((0, 0), 2, 3, 0) {
            assert_eq!(session.core().state.occupied(c), None, "old footprint freed");
        }
        for c in cells_of_footprint((10, 10), 2, 3, 0) {
            assert!(session.core().state.occupied(c).is_some(), "new footprint claimed");
        }
    }

    #[test]
    fn move_degraded_place_failure_still_consumes_the_action_id() {
        // WR-01: a Place leg that rejects AFTER the Delete folded must still SPEND the
        // shared action id. The exemplar's Delete folds, then the Place to an off-grid
        // cell rejects (the 2×3 body spills past GRID_MAX) — the move degrades to a
        // delete. The orphaned Delete must NOT share its action id with the next
        // unrelated command (the one-logical-action-per-undo-step invariant, UNDO-02).
        let mut session = GridSession::new(7);
        let handle = place_exemplar(&mut session, 0, 0); // exemplar place stamps action 0
        let log_len_before = session.edit_log().len();

        // Move to a cell whose 2×3 body spills off-grid -> the Place leg is OutOfBounds.
        assert_eq!(
            session
                .move_machine(handle, machine_kind::ROUTER, GRID_MAX, GRID_MAX)
                .err(),
            Some(CommandError::OutOfBounds),
            "the Place leg rejects off-grid; the move degrades to a delete"
        );

        // Exactly the Delete was appended (the rejected Place produced nothing).
        let log = session.edit_log();
        assert_eq!(
            log.len(),
            log_len_before + 1,
            "the degraded move logged only the folded Delete"
        );
        let orphaned_delete = log.last().expect("the folded delete record");
        assert!(
            matches!(orphaned_delete.op, EditOp::Delete { .. }),
            "the sole appended record is the Delete"
        );
        let orphan_action = orphaned_delete.action;

        // A subsequent unrelated command MUST receive a DISTINCT action id — the
        // orphaned Delete's id was spent even though the Place leg failed.
        let next = session
            .apply(GridCommand::Place {
                kind: machine_kind::SOURCE,
                cell_x: 0,
                cell_y: 0,
            })
            .expect("a free in-bounds place after the degraded move");
        assert_ne!(
            next.action, orphan_action,
            "the orphaned Delete must not share its action id with the next command (WR-01)"
        );
    }

    // 17-02: dock_validation_accepts_valid_rejects_incompat_nonadjacent_and_exempts_fault_port
    // drove the dock-legality predicate through GridCommand::Wire (now removed). The
    // SAME predicate is preserved in the Dock arm and covered by the dock_offload_* /
    // dock_load_* / dock_non_adjacent / dock_wrong_direction tests below.

    /// Draw a belt along `cells` and return its dense handle (the minted belt id is
    /// the last placed; the view assigns it a handle exactly as for a node).
    /// Place a TEE: the 2x2 kind that still declares NO `Role::Fault` nub after PILE-10
    /// widened the SINK and the ROUTER. It is what keeps the NON-SPATIAL fault-sentinel
    /// exemption path covered, and it is chosen for that property rather than by taste -
    /// see `fault_dock_non_spatial_exemption_preserved_for_a_nubless_kind`, which asserts
    /// the property before it relies on it.
    fn place_tee(session: &mut GridSession, cell_x: i32, cell_y: i32) -> u64 {
        session
            .apply(GridCommand::Place {
                kind: machine_kind::TEE,
                cell_x,
                cell_y,
            })
            .expect("a TEE is placed");
        let id = *session.core().last_tick.placed.last().expect("tee minted");
        session.view().handle_of(id).expect("tee got a handle")
    }

    fn draw_belt(session: &mut GridSession, cells: Vec<(i32, i32)>) -> u64 {
        session
            .apply(GridCommand::DrawBelt { cells })
            .expect("a clear drawn path is accepted");
        let id = *session.core().last_tick.placed.last().expect("belt minted");
        session.view().handle_of(id).expect("belt got a handle")
    }

    #[test]
    fn dock_offload_tail_to_out_port_accepts_and_freezes_resolved_editop() {
        // OFFLOAD: a ROUTER exemplar at (0,0) has its Out port (catalog index 1)
        // world-cell at (1,1) facing E (the middle row since 74.1-14; it was (1,2)).
        // A belt drawn TAIL-first at (2,1)->(3,1) presents its tail (first cell
        // (2,1)) one step E of the port, facing W = opposite(E). Docking the Tail to catalog port 1 (Out) accepts and
        // freezes EditOp::Dock with resolved ids AND the Out ROUTING key: the
        // ROUTER's single Out routes as port 0 (== fold_place's default route
        // port), so the frozen link key is 0, NOT the catalog index 1 (LIVE-02 /
        // RESEARCH Finding 1 — machines emit on routing port ids).
        let mut session = GridSession::new(7);
        let router = place_exemplar(&mut session, 0, 0);
        let belt = draw_belt(&mut session, vec![(2, 1), (3, 1)]);
        let (router_id, belt_id) = {
            let lk = session.view().lookup(session.core());
            (
                lk.resolve(router).expect("router id"),
                lk.resolve(belt).expect("belt id"),
            )
        };

        let rec = session
            .apply(GridCommand::Dock {
                belt,
                endpoint: fabrico_protocol::BeltEnd::Tail,
                node: router,
                port: 1,
            })
            .expect("a valid offload dock is accepted");
        assert_eq!(
            rec.op,
            EditOp::Dock {
                belt: belt_id,
                endpoint: BeltEnd::Tail,
                node: router_id,
                port: 0, // the Out ROUTING key (0-based among Role::Out ports)
            },
            "the frozen Dock carries resolved NodeIds + the Out routing key (catalog 1 -> emit 0)"
        );
    }

    #[test]
    fn dock_offload_tail_to_tee_second_out_freezes_routing_key_1() {
        // Multi-Out translation (LIVE-05 / Finding 1): a TEE at (0,0) is 2×2 with
        // catalog ports [In(0,0)W = 0, Out(1,0)E = 1, Out(1,1)E = 2]. tee.rs emits via
        // `push_output(port, ..)` for port in 0..outputs — the SECOND branch emits on
        // routing port 1, so a Tail dock to catalog index 2 must freeze link key 1
        // (the 0-based position among the Role::Out ports), or the second branch's
        // items vanish at the missing link. The second Out's world cell is (1,1)
        // facing E; the belt tail at (2,1) with second cell (3,1) faces W = opposite.
        let mut session = GridSession::new(7);
        session
            .apply(GridCommand::Place { kind: machine_kind::TEE, cell_x: 0, cell_y: 0 })
            .expect("the 2×2 tee is placed");
        let tee_id = *session.core().last_tick.placed.last().expect("tee minted");
        let tee = session.view().handle_of(tee_id).expect("tee got a handle");
        let belt = draw_belt(&mut session, vec![(2, 1), (3, 1)]);
        let belt_id = {
            let lk = session.view().lookup(session.core());
            lk.resolve(belt).expect("belt id")
        };

        let rec = session
            .apply(GridCommand::Dock {
                belt,
                endpoint: fabrico_protocol::BeltEnd::Tail,
                node: tee,
                port: 2, // the SECOND Out's catalog index
            })
            .expect("a valid offload dock to the tee's second Out is accepted");
        assert_eq!(
            rec.op,
            EditOp::Dock {
                belt: belt_id,
                endpoint: BeltEnd::Tail,
                node: tee_id,
                port: 1, // catalog 2 -> the 1st (0-based) Role::Out -> routing key 1
            },
            "the frozen Dock keys the tee's second Out on its EMIT port (catalog 2 -> emit 1)"
        );
    }

    #[test]
    fn dock_load_head_to_in_port_accepts() {
        // LOAD: a ROUTER exemplar at (5,5) has its In port (port 0) world-cell at (5,6)
        // facing W (the middle row since 74.1-14; it was (5,5)). A belt drawn
        // TAIL-first at (3,6)->(4,6) presents its HEAD (last cell (4,6)) one step W of
        // the port, facing E = opposite(W). Docking the Head to port 0 (In) accepts.
        let mut session = GridSession::new(7);
        let router = place_exemplar(&mut session, 5, 5);
        let belt = draw_belt(&mut session, vec![(3, 6), (4, 6)]);
        session
            .apply(GridCommand::Dock {
                belt,
                endpoint: fabrico_protocol::BeltEnd::Head,
                node: router,
                port: 0,
            })
            .expect("a valid load dock is accepted");
    }

    #[test]
    fn dock_non_adjacent_rejects_invalid_dock_and_produces_nothing() {
        // A belt drawn far from the router's Out port is non-adjacent -> InvalidDock,
        // producing NO record (state byte-identical, SC#2).
        let mut session = GridSession::new(7);
        let router = place_exemplar(&mut session, 0, 0);
        let belt = draw_belt(&mut session, vec![(50, 50), (51, 50)]);
        let before = snapshot(session.core());
        let log_len = session.edit_log().len();
        assert_eq!(
            session
                .apply(GridCommand::Dock {
                    belt,
                    endpoint: fabrico_protocol::BeltEnd::Tail,
                    node: router,
                    port: 1,
                })
                .err(),
            Some(CommandError::InvalidDock),
            "a non-adjacent dock is rejected"
        );
        assert_eq!(session.edit_log().len(), log_len, "no record produced");
        assert_eq!(snapshot(session.core()), before, "state byte-identical (SC#2)");
    }

    #[test]
    fn dock_wrong_direction_role_mismatch_rejects() {
        // Docking the belt TAIL (an OFFLOAD, expecting a machine `Out`) to the router's
        // In port (port 0, role In) is a direction/role mismatch -> InvalidDock, even
        // though port 0's world-cell (5,5) is adjacent+facing the belt tail at (4,5).
        let mut session = GridSession::new(7);
        let router = place_exemplar(&mut session, 5, 5);
        let belt = draw_belt(&mut session, vec![(4, 5), (3, 5)]);
        assert_eq!(
            session
                .apply(GridCommand::Dock {
                    belt,
                    endpoint: fabrico_protocol::BeltEnd::Tail,
                    node: router,
                    port: 0,
                })
                .err(),
            Some(CommandError::InvalidDock),
            "a Tail (offload) dock to an In port is role-incompatible"
        );
    }

    #[test]
    fn dock_to_portless_machine_rejects() {
        // A SOURCE is a port-less 1×1 point machine; docking a belt to any port index
        // on it has no declared port -> InvalidDock.
        let mut session = GridSession::new(7);
        session
            .apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 0, cell_y: 0 })
            .expect("place the port-less source");
        let src_id = *session.core().last_tick.placed.last().expect("source minted");
        let src = session.view().handle_of(src_id).expect("source handle");
        let belt = draw_belt(&mut session, vec![(2, 2), (3, 2)]);
        assert_eq!(
            session
                .apply(GridCommand::Dock {
                    belt,
                    endpoint: fabrico_protocol::BeltEnd::Tail,
                    node: src,
                    port: 0,
                })
                .err(),
            Some(CommandError::InvalidDock),
            "a dock to a port-less machine is rejected"
        );
    }

    // 17-02: dock_wire_minted_belt_without_geometry_rejects tested that a geometry-less
    // Wire-minted belt cannot be docked. With the node→node Wire removal there is no
    // way to mint a geometry-less belt any more (belts come only from DrawBelt), so the
    // scenario is unreachable and the test is retired.

    #[test]
    fn mediums_compatible_is_same_medium_equality() {
        // PORT-08: the SHARED predicate is `a == b` for now. A Mechanical belt docks a
        // Mechanical port; a wire docks a wire. Cross-medium is incompatible. Phase-37's
        // DrawWire reuses this SAME rule for the wire->port direction (one rule, both ways).
        assert!(mediums_compatible(Medium::Mechanical, Medium::Mechanical));
        assert!(mediums_compatible(Medium::Electrical, Medium::Electrical));
        assert!(!mediums_compatible(Medium::Mechanical, Medium::Electrical));
        assert!(!mediums_compatible(Medium::Electrical, Medium::Mechanical));
    }

    #[test]
    fn medium_mismatch_display_renders() {
        // The typed reject renders a functional message (project copy rule: hyphens/
        // parens, no em dash), never a panic.
        let msg = format!("{}", CommandError::MediumMismatch);
        assert!(!msg.is_empty(), "MediumMismatch has a Display arm");
        assert!(!msg.contains('\u{2014}'), "no em dash in the reject copy");
    }

    #[test]
    fn dock_belt_onto_electrical_port_rejects_medium_mismatch_byte_identical() {
        // PORT-08 reachability: place a Router (HTTP-style electrical In port), draw a
        // belt adjacent to it, dock the belt HEAD onto that electrical In port. A belt is
        // always a Mechanical carrier, so the medium gate rejects with a typed
        // MediumMismatch BEFORE the dock is frozen — nothing folded, session byte-identical.
        let mut session = GridSession::new(7);
        let router = place_exemplar(&mut session, 5, 5);
        // Add an ELECTRICAL In port. `reseat_ports` seats it as the SECOND In, local
        // (0,1) W, so it faces world (4,6) whatever the Router's Out arity is; its
        // catalog INDEX is the end of the list and is read back rather than written down
        // (it moved from 2 to 4 when 63-07 widened the arity).
        session
            .apply(GridCommand::AddPort {
                node: router,
                role: port_role::IN,
                side: 3,
                medium: port_medium::ELECTRICAL,
            })
            .expect("AddPort electrical In accepted");
        // The electrical In is the LAST catalog index; its facing cell is (4,6). Draw a
        // belt whose HEAD (last cell (4,6)) is one step W of the port, facing
        // E = opposite(W).
        let elec_in = {
            let core = session.core();
            let router_id = session
                .view()
                .lookup(core)
                .resolve(router)
                .expect("the exemplar router is live");
            let ports = core.state.ports_of(router_id).expect("router ports");
            u16::try_from(ports.len() - 1).expect("port index fits u16")
        };
        let belt = draw_belt(&mut session, vec![(3, 6), (4, 6)]);
        let before = snapshot(session.core());
        let log_len = session.edit_log().len();
        assert_eq!(
            session
                .apply(GridCommand::Dock {
                    belt,
                    endpoint: fabrico_protocol::BeltEnd::Head,
                    node: router,
                    port: elec_in,
                })
                .err(),
            Some(CommandError::MediumMismatch),
            "docking a Mechanical belt onto an Electrical port is a typed MediumMismatch"
        );
        assert_eq!(session.edit_log().len(), log_len, "the reject folds nothing (SC#2)");
        assert_eq!(snapshot(session.core()), before, "state byte-identical on reject (SC#2)");
    }

    #[test]
    fn dock_belt_onto_mechanical_port_still_accepts() {
        // The positive companion: a Mechanical belt docking a Mechanical port is
        // compatible and still accepts (the gate does not over-reject). The exemplar
        // router's In port (catalog index 0) is Mechanical at world (5,6) facing W
        // (the middle row since 74.1-14).
        let mut session = GridSession::new(7);
        let router = place_exemplar(&mut session, 5, 5);
        let belt = draw_belt(&mut session, vec![(3, 6), (4, 6)]);
        session
            .apply(GridCommand::Dock {
                belt,
                endpoint: fabrico_protocol::BeltEnd::Head,
                node: router,
                port: 0,
            })
            .expect("a compatible Mechanical dock still accepts (gate does not over-reject)");
    }

    #[test]
    fn router_preset_ports_out_count_equals_the_shared_arity() {
        // ROUTE-02 SC2. The preset Out count is asserted as an EQUALITY between two
        // DERIVED values and never against a written number. An assertion spelled
        // `assert_eq!(outs, 2)` was what shipped here before, and it passed happily
        // while the catalog said three: a restated literal cannot see a wrong shared
        // constant, which is the whole drift this phase closes.
        for medium in [Medium::Mechanical, Medium::Electrical] {
            let ports = router_preset_ports(medium);
            assert_eq!(
                count_role(&ports, Role::Out),
                ROUTER_OUT_ARITY,
                "the preset Out count IS the shared arity, not a number written here",
            );
            assert_eq!(count_role(&ports, Role::In), 1, "one In");
            assert_eq!(count_role(&ports, Role::Fault), 1, "one Fault (85-05, D-22)");
            assert_eq!(
                ports.len(),
                2 + ROUTER_OUT_ARITY as usize,
                "one In, the shared arity and one Fault, no stray port",
            );
            assert!(
                ports.iter().filter(|p| p.role != Role::Fault).all(|p| p.medium == medium),
                "every In and Out carries `medium`"
            );
            assert!(
                ports.iter().filter(|p| p.role == Role::Fault).all(|p| p.medium == Medium::Mechanical),
                "the Fault is Mechanical whatever the preset medium: a fault drains on a belt"
            );
            // List ORDER is load-bearing: `reseat_ports` assigns a slot from a port's
            // position among its own role, and the host fold re-seats identically, so
            // the In has to stay first or every seeded offset moves.
            assert_eq!(ports[0].role, Role::In, "the In is first in the producer's list");
            // Re-seated onto the Router base, the seeded In, Outs and (since 85-05) Fault
            // land on EXACTLY the catalog Router's cells (74.1-14, the middle-layout
            // decision of 2026-10-04: the reseat rule is centre-out from the catalog box, and the
            // catalog arm is its hand-written output). Compared to the literal catalog
            // arm, never to a second derivation of the rule, so a drift in either side
            // shows. The catalog's Fault is Mechanical and so is the preset's.
            let (_, catalog) = port_catalog(machine_kind::ROUTER);
            let expected: Vec<Port> = catalog
                .iter()
                .map(|p| if p.role == Role::Fault { *p } else { Port { medium, ..*p } })
                .collect();
            assert_eq!(ports, expected, "the preset seats its nubs on the catalog Router's cells");
        }
    }

    #[test]
    fn place_router_preset_both_media_mint_one_router_engine() {
        // ROUTE-06 (CONTEXT hard rule): HTTP Router (electrical) and Item Router
        // (mechanical) are TWO presets over the ONE Node::Router engine — both fold to
        // Node::Router, differing ONLY by Port.medium. Routing is NOT forked per medium.
        use fabrico_core::state::Node;
        let mut session = GridSession::new(3);
        session
            .place_router_preset(Medium::Mechanical, 0, 0)
            .expect("Item Router (mechanical) preset places");
        // The preset's final leg is an AddPort (not a Place), so locate the router by its
        // anchor cell rather than last_tick.placed.
        let item_id = session.core().state.occupied((0, 0)).expect("item router at (0,0)");
        session
            .place_router_preset(Medium::Electrical, 10, 10)
            .expect("HTTP Router (electrical) preset places");
        let http_id = session.core().state.occupied((10, 10)).expect("http router at (10,10)");

        // BOTH mint the SAME Node::Router engine (one engine, two presets).
        assert!(
            matches!(session.core().state.node(item_id), Some(Node::Router(_))),
            "the mechanical preset mints Node::Router"
        );
        assert!(
            matches!(session.core().state.node(http_id), Some(Node::Router(_))),
            "the electrical preset mints Node::Router (SAME engine)"
        );

        // The two placed machines' In and Out media DIFFER (mechanical vs electrical);
        // both carry one Fault at Mechanical since 85-05 (D-22).
        let item_ports = session.core().state.ports_of(item_id).expect("item ports").to_vec();
        let http_ports = session.core().state.ports_of(http_id).expect("http ports").to_vec();
        assert!(
            item_ports.iter().all(|p| p.medium == Medium::Mechanical),
            "Item Router ports are all Mechanical"
        );
        assert!(
            http_ports.iter().filter(|p| p.role != Role::Fault).all(|p| p.medium == Medium::Electrical),
            "HTTP Router In and Outs are all Electrical"
        );
        for ports in [&item_ports, &http_ports] {
            assert_eq!(
                ports.iter().filter(|p| p.role == Role::Fault).map(|p| p.medium).collect::<Vec<_>>(),
                vec![Medium::Mechanical],
                "each preset carries one Fault, Mechanical",
            );
        }
        // Both reach the SAME profile, and the Out half is the shared arity rather
        // than a number restated here.
        for ports in [&item_ports, &http_ports] {
            assert_eq!(count_role(ports, Role::In), 1, "one In");
            assert_eq!(
                count_role(ports, Role::Out),
                ROUTER_OUT_ARITY,
                "each preset reaches the shared Out arity",
            );
        }
    }

    #[test]
    fn router_presets_lists_two_entries_over_one_router_kind() {
        // ROUTE-06 palette: two MachineCatalogEntry values the frontend lists — HTTP
        // Router (electrical) and Item Router (mechanical) — both kind=ROUTER, sourced
        // from router_preset_ports through the SINGLE ts-rs producer (no new serialized
        // type/field, no new machine_kind). The entries differ ONLY in the medium byte.
        let presets = router_presets();
        assert_eq!(presets.len(), 2, "the palette lists exactly two Router presets");
        for e in &presets {
            assert_eq!(e.kind, machine_kind::ROUTER, "both presets are the ONE Router kind");
            let ins = e.ports.iter().filter(|p| p.role == port_role::IN).count();
            let outs = e.ports.iter().filter(|p| p.role == port_role::OUT).count();
            assert_eq!(ins, 1, "each preset is 1-in");
            assert_eq!(
                u16::try_from(outs).expect("the preset Out count fits a u16"),
                ROUTER_OUT_ARITY,
                "each preset lists the shared Out arity, never a number written here",
            );
        }
        // Exactly one electrical (HTTP) and one mechanical (Item) preset, judged on the
        // In and Outs; each carries one Fault at Mechanical since 85-05 (D-22).
        let in_out = |e: &MachineCatalogEntry| -> Vec<u8> {
            e.ports.iter().filter(|p| p.role != port_role::FAULT).map(|p| p.medium).collect()
        };
        let all_elec = |e: &MachineCatalogEntry| in_out(e).iter().all(|m| *m == port_medium::ELECTRICAL);
        let all_mech = |e: &MachineCatalogEntry| in_out(e).iter().all(|m| *m == port_medium::MECHANICAL);
        assert_eq!(presets.iter().filter(|e| all_elec(e)).count(), 1, "one HTTP (electrical) preset");
        assert_eq!(presets.iter().filter(|e| all_mech(e)).count(), 1, "one Item (mechanical) preset");
        for e in &presets {
            let faults: Vec<u8> =
                e.ports.iter().filter(|p| p.role == port_role::FAULT).map(|p| p.medium).collect();
            assert_eq!(faults, vec![port_medium::MECHANICAL], "each preset lists one Mechanical Fault");
        }
    }

    #[test]
    fn place_router_preset_is_a_single_undoable_action() {
        // The whole preset placement (Place + the symmetric RemovePort/AddPort seeding)
        // shares ONE action id, so a SINGLE Undo reverts the entire preset in one step.
        let mut session = GridSession::new(3);
        session
            .place_router_preset(Medium::Electrical, 0, 0)
            .expect("preset places");
        let id = session.core().state.occupied((0, 0)).expect("router at (0,0)");
        assert!(session.core().state.node(id).is_some(), "router is live after the preset");
        let footprint = session.core().state.footprint_of(id).expect("router footprint");
        // ONE undo reverts the whole preset group — the router (and every seeded port
        // edit) is gone in a single step.
        session.apply(GridCommand::Undo).expect("undo reverts the preset");
        assert!(
            session.core().state.node(id).is_none(),
            "a single Undo removes the whole preset (Place + all port edits, one action)"
        );
        // Every cell the preset claimed is freed by the ONE undo.
        for c in cells_of_footprint((0, 0), footprint.w, footprint.h, footprint.rot) {
            assert_eq!(
                session.core().state.occupied(c),
                None,
                "the preset's footprint cells are freed by the single Undo"
            );
        }
    }

    /// Place a FACTORY (3×3, In/Out/Fault catalog) at `(cell_x, cell_y)` and return
    /// its dense handle. The Fault port is catalog index 2 (S-center nub).
    fn place_factory(session: &mut GridSession, cell_x: i32, cell_y: i32) -> u64 {
        session
            .apply(GridCommand::Place {
                kind: machine_kind::FACTORY,
                cell_x,
                cell_y,
            })
            .expect("the 3×3 factory is placed");
        let id = *session.core().last_tick.placed.last().expect("factory minted");
        session.view().handle_of(id).expect("factory got a handle")
    }

    #[test]
    fn fault_dock_offload_to_factory_fault_nub_accepts_and_keys_on_fault_port() {
        // CAT-02 / Option A: a FACTORY at (0,0) has its Role::Fault port (catalog
        // index 2) world-cell at (1,2) facing S; the facing cell is (1,3). A belt drawn
        // TAIL-first at (1,3)->(1,4) presents its tail (first cell (1,3)) one step S of
        // the port, facing N = opposite(S). Docking the Tail (OFFLOAD) to the spatial
        // fault index (2) is spatially validated EXACTLY like an Out dock and accepts —
        // and the frozen link key is resolved to FAULT_PORT (== the fault-emit key), so
        // a docked fault belt actually receives faulted items.
        let mut session = GridSession::new(7);
        let factory = place_factory(&mut session, 0, 0);
        let belt = draw_belt(&mut session, vec![(1, 3), (1, 4)]);
        let (factory_id, belt_id) = {
            let lk = session.view().lookup(session.core());
            (
                lk.resolve(factory).expect("factory id"),
                lk.resolve(belt).expect("belt id"),
            )
        };

        let rec = session
            .apply(GridCommand::Dock {
                belt,
                endpoint: fabrico_protocol::BeltEnd::Tail,
                node: factory,
                port: 2, // the SPATIAL Role::Fault index
            })
            .expect("a facing offload dock to the fault nub is accepted");
        assert_eq!(
            rec.op,
            EditOp::Dock {
                belt: belt_id,
                endpoint: BeltEnd::Tail,
                node: factory_id,
                port: FAULT_PORT, // resolved to the fault-emit key (Option A)
            },
            "the accepted fault dock keys the link on FAULT_PORT, not the spatial index"
        );
    }

    #[test]
    fn fault_dock_non_facing_rejects_invalid_dock() {
        // The fault nub is now SPATIALLY validated (the blanket FAULT_PORT exemption is
        // gone for a real fault port): a belt whose tail does NOT face the fault port's
        // world-cell is rejected with InvalidDock, producing NOTHING (SC#2). Under the
        // OLD blanket exemption this dock would have been (wrongly) accepted.
        let mut session = GridSession::new(7);
        let factory = place_factory(&mut session, 0, 0);
        let belt = draw_belt(&mut session, vec![(40, 40), (41, 40)]);
        let before = snapshot(session.core());
        let log_len = session.edit_log().len();
        assert_eq!(
            session
                .apply(GridCommand::Dock {
                    belt,
                    endpoint: fabrico_protocol::BeltEnd::Tail,
                    node: factory,
                    port: 2,
                })
                .err(),
            Some(CommandError::InvalidDock),
            "a non-facing dock to the fault nub is spatially rejected"
        );
        assert_eq!(session.edit_log().len(), log_len, "no record produced");
        assert_eq!(snapshot(session.core()), before, "state byte-identical (SC#2)");
    }

    /// Accept `rec`'s Tail dock and prove the link it froze is in the fold: the frozen op
    /// names `carrier` and `target`, and `links` maps `(target, key)` to `(carrier, 0)`,
    /// where `key` is the LINK KEY the arm translated (the Out routing index, or
    /// `FAULT_PORT`). Shared by the two doorstep-corner pins below.
    fn assert_tail_link_recorded(
        session: &GridSession,
        rec: &EditRecord,
        carrier: NodeId,
        target: NodeId,
    ) {
        let EditOp::Dock { belt, endpoint, node, port } = rec.op.clone() else {
            panic!("an accepted Dock freezes an EditOp::Dock, got {:?}", rec.op);
        };
        assert_eq!(
            (belt, endpoint, node),
            (carrier, BeltEnd::Tail, target),
            "the frozen Dock names both ends",
        );
        assert_eq!(
            session.core().state.link_target((target, port)),
            Some((carrier, 0)),
            "the accepted Tail dock wrote the link (target, key) -> (carrier, 0)",
        );
    }

    #[test]
    fn fault_dock_tail_turning_at_the_doorstep_is_accepted() {
        // CORNER-06 (phase 74.1), the MACHINE-SOCKET shape. A FACTORY at (0,0) has its
        // Fault port (catalog index 2) at (1,2) facing S, so its doorstep is (1,3). The
        // belt starts ON that doorstep and turns EAST at once: (1,3) -> (2,3) -> (3,3).
        // Its Tail's outward side is W (tiles[0] - tiles[1]), perpendicular to S.
        //
        // Before 74.1 the host demanded outward == opposite(S) == N and refused this as
        // InvalidDock (watched). The narrowed rule refuses on facing only when outward
        // EQUALS the target side, the one geometry where the carrier's inner tile would
        // sit on the target's own cell. So a belt that turns at a doorstep docks.
        let mut session = GridSession::new(7);
        let factory = place_factory(&mut session, 0, 0);
        let belt = draw_belt(&mut session, vec![(1, 3), (2, 3), (3, 3)]);
        let (factory_id, belt_id) = {
            let lk = session.view().lookup(session.core());
            (
                lk.resolve(factory).expect("factory id"),
                lk.resolve(belt).expect("belt id"),
            )
        };
        let log_len = session.edit_log().len();
        let rec = session
            .apply(GridCommand::Dock {
                belt,
                endpoint: fabrico_protocol::BeltEnd::Tail,
                node: factory,
                port: 2,
            })
            .expect("a Tail that turns at the Fault port's doorstep is accepted")
            .clone();
        assert_eq!(session.edit_log().len(), log_len + 1, "exactly one record produced");
        assert_tail_link_recorded(&session, &rec, belt_id, factory_id);
    }

    #[test]
    fn belt_seam_tail_turning_at_the_doorstep_is_accepted() {
        // CORNER-06 (phase 74.1), the BELT-SEAM shape, judged by the SAME predicate as the
        // machine socket above and never split from it. The target belt runs EAST
        // (10,10) -> (11,10), so its free Head is at (11,10) with outward side E and its
        // doorstep is (12,10). The carrier starts ON that doorstep and runs NORTH:
        // (12,10) -> (12,9). Its Tail's outward side is S, perpendicular to E.
        //
        // Before 74.1 this refused as InvalidDock (outward S != opposite(E) == W,
        // watched). After it, a belt drawn out of a belt end that turns at once joins.
        let mut session = GridSession::new(7);
        let target = draw_belt(&mut session, vec![(10, 10), (11, 10)]);
        let carrier = draw_belt(&mut session, vec![(12, 10), (12, 9)]);
        let (target_id, carrier_id) = {
            let lk = session.view().lookup(session.core());
            (
                lk.resolve(target).expect("target belt id"),
                lk.resolve(carrier).expect("carrier id"),
            )
        };
        let log_len = session.edit_log().len();
        let rec = session
            .apply(GridCommand::Dock {
                belt: carrier,
                endpoint: fabrico_protocol::BeltEnd::Tail,
                node: target,
                port: 1, // a belt's catalog is [Tail (In) = 0, Head (Out) = 1]
            })
            .expect("a Tail that turns at a belt Head's doorstep is accepted")
            .clone();
        assert_eq!(session.edit_log().len(), log_len + 1, "exactly one record produced");
        assert_tail_link_recorded(&session, &rec, carrier_id, target_id);
    }

    #[test]
    fn head_dock_arriving_sideways_at_an_in_is_accepted() {
        // CORNER-06 / D-14 (phase 74.1), the HEAD shape the two Tail pins above leave
        // unpinned at the host (review IN-04). A FACTORY at (5,5) has its In port
        // (catalog index 0) at (5,6) facing W, so its doorstep is (4,6). The carrier runs
        // SOUTH down the factory's west face, (4,4) -> (4,5) -> (4,6), and ends ON that
        // doorstep. Its Head's outward side is S (tiles[n-1] - tiles[n-2]), perpendicular
        // to W: the belt arrives sideways rather than head-on.
        //
        // The pre-74.1 rule demanded outward == opposite(W) == E and refused this as
        // InvalidDock (watched, with the narrowed clause swapped back in a throwaway
        // worktree). The narrowed rule refuses only outward == W, so it docks.
        let mut session = GridSession::new(7);
        let factory = place_factory(&mut session, 5, 5);
        let belt = draw_belt(&mut session, vec![(4, 4), (4, 5), (4, 6)]);
        let (factory_id, belt_id) = {
            let lk = session.view().lookup(session.core());
            (
                lk.resolve(factory).expect("factory id"),
                lk.resolve(belt).expect("belt id"),
            )
        };
        let log_len = session.edit_log().len();
        let rec = session
            .apply(GridCommand::Dock {
                belt,
                endpoint: fabrico_protocol::BeltEnd::Head,
                node: factory,
                port: 0,
            })
            .expect("a Head that arrives sideways at an In's doorstep is accepted")
            .clone();
        assert_eq!(session.edit_log().len(), log_len + 1, "exactly one record produced");
        assert_eq!(
            rec.op,
            EditOp::Dock {
                belt: belt_id,
                endpoint: BeltEnd::Head,
                node: factory_id,
                port: 0, // an In's link key is its catalog index
            },
            "the frozen Dock names the carrier's Head and the factory's In",
        );
        assert_eq!(
            session.core().state.link_target((belt_id, 0)),
            Some((factory_id, 0)),
            "the accepted Head dock wrote the link (carrier, 0) -> (factory, In 0)",
        );
    }

    /// Fold ONE record onto the session exactly as a hand-edited log would arrive: stamped
    /// at the session tick under a fresh sequence and action, appended to the edit log,
    /// folded VERBATIM by the core (no validate), and projected into the view. This is the
    /// only way to reach a state no command produces, consistently in BOTH `core` and
    /// `view`; `core_mut` alone bypasses the view the Dock arm validates against.
    fn fold_forged_record(session: &mut GridSession, op: EditOp) -> NodeId {
        let record = EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: session.sequence,
            tick: session.core.tick,
            action: session.action,
            op,
        };
        session.sequence += 1;
        session.action += 1;
        session.edit_log.push(record);
        session
            .core
            .advance_edits(std::slice::from_ref(session.edit_log.last().expect("pushed")), &[]);
        session.view.apply_tick(&session.core);
        session.reconstruct_projection();
        *session.core.last_tick.placed.last().expect("the forged record minted a node")
    }

    /// A forged board: a 1x1 router at (5,5) with one Out facing E, and a two-tile belt
    /// whose FIRST tile (the Tail end) is (6,5), the Out's doorstep, and whose second
    /// tile is `inner`. Returns `(session, router handle, belt handle)`.
    fn forged_carrier_board(inner: (i32, i32)) -> (GridSession, u64, u64) {
        use fabrico_core::state::{Axis, BeltTile, TileKind};
        let mut session = GridSession::new(7);
        let router = fold_forged_record(
            &mut session,
            EditOp::Place {
                kind: machine_kind::ROUTER,
                cell_x: 5,
                cell_y: 5,
                w: 1,
                h: 1,
                ports: vec![Port {
                    local_offset: (0, 0),
                    side: Side::E,
                    role: Role::Out,
                    medium: Medium::Mechanical,
                }],
                rot: 0,
            },
        );
        let straight = TileKind::Straight { axis: Axis::X };
        let belt = fold_forged_record(
            &mut session,
            EditOp::DrawBelt {
                tiles: vec![
                    BeltTile::new((6, 5), straight),
                    BeltTile::new(inner, straight),
                ],
            },
        );
        let router_h = session.view().handle_of(router).expect("router got a handle");
        let belt_h = session.view().handle_of(belt).expect("belt got a handle");
        (session, router_h, belt_h)
    }

    #[test]
    fn a_carrier_whose_inner_tile_is_the_targets_cell_is_refused() {
        // CORNER-06 (phase 74.1), the KEPT TERM of the narrowed facing clause (D-13). The
        // carrier's Tail end (6,5) is the Out's doorstep, so ROLE (Tail onto an Out),
        // MEDIUM (Mechanical onto Mechanical) and ADJACENCY all pass; its inner tile is
        // (5,5), the router's own cell, so its outward side (tiles[0] - tiles[1]) is E,
        // EQUAL to the port side. That is the one geometry the narrowed clause refuses,
        // and no command produces it (DrawBelt refuses a tile on a machine cell), so the
        // board is forged through the log.
        //
        // The twin below differs ONLY in the inner tile, (7,5) instead of (5,5), and is
        // accepted, which shows every check before the facing clause passes on this
        // board. Watched: with the `oside == mside` refusal alone deleted, this test goes
        // RED because the forged dock is accepted (74.1-03-SUMMARY.md).
        let (mut session, router, belt) = forged_carrier_board((5, 5));
        let before = snapshot(session.core());
        let log_len = session.edit_log().len();
        assert_eq!(
            session
                .apply(GridCommand::Dock {
                    belt,
                    endpoint: fabrico_protocol::BeltEnd::Tail,
                    node: router,
                    port: 0,
                })
                .err(),
            Some(CommandError::InvalidDock),
            "a carrier whose inner tile is the target's own cell is refused on facing"
        );
        assert_eq!(session.edit_log().len(), log_len, "no record produced");
        assert_eq!(snapshot(session.core()), before, "state byte-identical (SC#2)");

        let (mut twin, twin_router, twin_belt) = forged_carrier_board((7, 5));
        twin.apply(GridCommand::Dock {
            belt: twin_belt,
            endpoint: fabrico_protocol::BeltEnd::Tail,
            node: twin_router,
            port: 0,
        })
        .expect("the same board with the inner tile on the far side docks");
    }

    #[test]
    fn fault_dock_head_load_to_fault_port_rejects_role_mismatch() {
        // Errors flow OUT of a fault port; a belt may only OFFLOAD (Tail), never flow
        // IN. A HEAD (load) dock targeting the fault nub is a role/direction mismatch
        // -> InvalidDock, even when the geometry would otherwise face.
        let mut session = GridSession::new(7);
        let factory = place_factory(&mut session, 0, 0);
        // A belt whose HEAD (last cell) sits at the fault port's facing cell (1,3).
        let belt = draw_belt(&mut session, vec![(1, 4), (1, 3)]);
        assert_eq!(
            session
                .apply(GridCommand::Dock {
                    belt,
                    endpoint: fabrico_protocol::BeltEnd::Head,
                    node: factory,
                    port: 2,
                })
                .err(),
            Some(CommandError::InvalidDock),
            "a Head (load) dock to a Fault (output) port is role-incompatible"
        );
    }

    #[test]
    fn fault_dock_sentinel_to_node_with_real_fault_nub_is_spatially_validated() {
        // 20-review WR-03: the FAULT_PORT exemption is NODE-AWARE. A FACTORY
        // declares a REAL spatial Role::Fault nub, so a wire client passing the
        // sentinel directly must NOT bypass dock geometry: a spatially-
        // disconnected belt is rejected with InvalidDock, producing NOTHING
        // (SC#2) — exactly like the same dock addressed via catalog index 2
        // (`fault_dock_non_facing_rejects_invalid_dock`). Before the fix the
        // sentinel skipped ALL geometry and linked the disconnected belt,
        // teleporting faulted items to it.
        let mut session = GridSession::new(7);
        let factory = place_factory(&mut session, 0, 0);
        let belt = draw_belt(&mut session, vec![(40, 40), (41, 40)]);
        let before = snapshot(session.core());
        let log_len = session.edit_log().len();
        assert_eq!(
            session
                .apply(GridCommand::Dock {
                    belt,
                    endpoint: fabrico_protocol::BeltEnd::Tail,
                    node: factory,
                    port: FAULT_PORT, // the sentinel, sent directly by a wire client
                })
                .err(),
            Some(CommandError::InvalidDock),
            "the sentinel resolves to the FACTORY's real fault nub and is \
             spatially validated — a disconnected belt is rejected (WR-03)"
        );
        assert_eq!(session.edit_log().len(), log_len, "no record produced");
        assert_eq!(snapshot(session.core()), before, "state byte-identical (SC#2)");
    }

    #[test]
    fn fault_dock_sentinel_to_factory_with_valid_geometry_accepts_like_index() {
        // 20-review WR-03 companion: the node-aware resolution must not regress
        // the VALID case — the sentinel with correct geometry accepts and freezes
        // the SAME record as the index-2 addressing
        // (`fault_dock_offload_to_factory_fault_nub_accepts_and_keys_on_fault_port`):
        // the two accept envelopes for the same logical link now agree.
        let mut session = GridSession::new(7);
        let factory = place_factory(&mut session, 0, 0);
        let belt = draw_belt(&mut session, vec![(1, 3), (1, 4)]);
        let (factory_id, belt_id) = {
            let lk = session.view().lookup(session.core());
            (
                lk.resolve(factory).expect("factory id"),
                lk.resolve(belt).expect("belt id"),
            )
        };
        let rec = session
            .apply(GridCommand::Dock {
                belt,
                endpoint: fabrico_protocol::BeltEnd::Tail,
                node: factory,
                port: FAULT_PORT, // the sentinel, resolved to the spatial nub
            })
            .expect("a facing sentinel-addressed fault dock is accepted");
        assert_eq!(
            rec.op,
            EditOp::Dock {
                belt: belt_id,
                endpoint: BeltEnd::Tail,
                node: factory_id,
                port: FAULT_PORT,
            },
            "the sentinel addressing freezes the identical FAULT_PORT-keyed record \
             the index-2 addressing freezes (the envelopes agree, WR-03)"
        );
    }

    #[test]
    fn fault_dock_non_spatial_exemption_preserved_for_a_nubless_kind() {
        // RETARGETED in phase 71, from the ROUTER to the TEE, and NOT deleted.
        //
        // It read `fault_dock_non_spatial_exemption_preserved_for_router` and its comment
        // said "a ROUTER has NO Role::Fault nub ... this is the ONLY surviving exemption
        // path". PILE-10 gives the Router a real spatial nub, so that sentence is now
        // false OF THE ROUTER - but the exemption path itself is unchanged and still
        // reachable, from every kind that declares no nub. Deleting this test would have
        // dropped the only coverage of that branch; retargeting keeps it.
        //
        // The Router's own case is now the SPATIAL one and it has its own test below
        // (`fault_dock_on_a_router_is_now_spatially_validated`), which is where the
        // inverted claim went rather than into a comment nobody re-reads.
        let mut session = GridSession::new(7);
        let tee = place_tee(&mut session, 0, 0);
        // THE PROPERTY THIS TEST RESTS ON, asserted rather than assumed: the target kind
        // really declares no `Role::Fault` port. If a later phase gives the TEE a nub,
        // this fires immediately instead of the test quietly measuring the spatial path.
        let (_, tee_ports) = port_catalog(machine_kind::TEE);
        assert!(
            tee_ports.iter().all(|p| p.role != Role::Fault),
            "the TEE must still be nub-less for this to exercise the NON-SPATIAL branch"
        );
        let belt = draw_belt(&mut session, vec![(20, 20), (21, 20)]);
        let (tee_id, belt_id) = {
            let lk = session.view().lookup(session.core());
            (
                lk.resolve(tee).expect("tee id"),
                lk.resolve(belt).expect("belt id"),
            )
        };
        let rec = session
            .apply(GridCommand::Dock {
                belt,
                endpoint: fabrico_protocol::BeltEnd::Tail,
                node: tee,
                port: FAULT_PORT, // the reserved NON-spatial sentinel, passed directly
            })
            .expect("a non-spatial FAULT_PORT dock keeps the exemption and is accepted");
        assert_eq!(
            rec.op,
            EditOp::Dock {
                belt: belt_id,
                endpoint: BeltEnd::Tail,
                node: tee_id,
                port: FAULT_PORT,
            },
            "the non-spatial exemption freezes the dock on FAULT_PORT without geometry"
        );
    }

    #[test]
    fn fault_dock_on_a_router_is_now_spatially_validated() {
        // THE INVERSION PILE-10 CAUSES, written down as an assertion rather than left as
        // the absence of the test it replaced.
        //
        // A ROUTER now declares a spatial `Role::Fault` nub at `S@(0,2)`, so
        // `resolve_spatial_port` maps the sentinel onto it and the dock runs the FULL
        // facing/adjacency validation - exactly the path golden 0016 already certifies
        // for the FACTORY. Two arms, because only the pair says what changed:
        //
        //   * a belt FACING the nub is accepted and still freezes the record on
        //     FAULT_PORT, so the dock key equals the fault-emit key and a docked belt
        //     really receives the faults; and
        //   * a belt nowhere near the machine is now REFUSED, where before PILE-10 the
        //     blanket exemption accepted it and linked a spatially-disconnected belt.
        //
        // The second arm is the behaviour change, and it is an improvement: the Router
        // and the Factory now agree on what a fault dock has to look like.
        let mut session = GridSession::new(7);
        let router = place_exemplar(&mut session, 0, 0);
        // The nub is at world (0,2) facing S. A belt drawn TAIL-first (0,3)->(0,4)
        // presents its tail one step S of the nub with an outward step of N =
        // opposite(S), which is the offload geometry an Out dock requires.
        let facing = draw_belt(&mut session, vec![(0, 3), (0, 4)]);
        let (router_id, facing_id) = {
            let lk = session.view().lookup(session.core());
            (
                lk.resolve(router).expect("router id"),
                lk.resolve(facing).expect("belt id"),
            )
        };
        let rec = session
            .apply(GridCommand::Dock {
                belt: facing,
                endpoint: fabrico_protocol::BeltEnd::Tail,
                node: router,
                port: FAULT_PORT,
            })
            .expect("a FACING sentinel-addressed fault dock on a Router is accepted");
        assert_eq!(
            rec.op,
            EditOp::Dock {
                belt: facing_id,
                endpoint: BeltEnd::Tail,
                node: router_id,
                port: FAULT_PORT,
            },
            "the spatial path still freezes the record on FAULT_PORT, so dock key == \
             emit key (the Option-A reconciliation, unchanged)"
        );

        // The arm that would have passed before PILE-10 and must not now.
        let stranded = draw_belt(&mut session, vec![(20, 20), (21, 20)]);
        let before = snapshot(session.core());
        let log_len = session.edit_log().len();
        assert_eq!(
            session
                .apply(GridCommand::Dock {
                    belt: stranded,
                    endpoint: fabrico_protocol::BeltEnd::Tail,
                    node: router,
                    port: FAULT_PORT,
                })
                .err(),
            Some(CommandError::InvalidDock),
            "a belt nowhere near the nub is REFUSED now that the Router has one - the \
             blanket exemption accepted exactly this board before PILE-10"
        );
        assert_eq!(session.edit_log().len(), log_len, "no record produced");
        assert_eq!(snapshot(session.core()), before, "state byte-identical (SC#2)");
    }

    #[test]
    fn fault_dock_non_spatial_head_load_to_fault_port_rejects_role_mismatch() {
        // WR-04: even on the NON-SPATIAL exemption path (port == FAULT_PORT passed
        // directly, e.g. a ROUTER whose fault output has no perimeter nub), a fault port
        // is offload-only — errors flow OUT, a belt may only OFFLOAD (Tail), never flow
        // IN. A HEAD (load) dock to FAULT_PORT is a role/direction mismatch -> InvalidDock,
        // producing NOTHING (SC#2). This closes the accept-path asymmetry: previously the
        // non-spatial branch skipped ALL validation and (wrongly) linked a belt delivering
        // INTO the output-only fault port. The spatial path (index 2) already rejects this
        // via `role_ok` — the two fault-dock paths now agree.
        // RETARGETED in phase 71, from the ROUTER to the TEE, for a reason this project
        // calls its signature defect class: after PILE-10 gave the Router a nub this
        // test STILL PASSED on a Router - but for a DIFFERENT reason, the belt being
        // nowhere near the machine, and it would have gone on passing with the role
        // guard on this branch DELETED. A check that cannot fail is worse than no check.
        // The TEE still declares no nub, so this reaches the branch it is named after.
        let mut session = GridSession::new(7);
        let tee = place_tee(&mut session, 0, 0);
        let (_, tee_ports) = port_catalog(machine_kind::TEE);
        assert!(
            tee_ports.iter().all(|p| p.role != Role::Fault),
            "the TEE must still be nub-less for this to exercise the NON-SPATIAL branch"
        );
        let belt = draw_belt(&mut session, vec![(20, 20), (21, 20)]);
        let before = snapshot(session.core());
        let log_len = session.edit_log().len();
        assert_eq!(
            session
                .apply(GridCommand::Dock {
                    belt,
                    endpoint: fabrico_protocol::BeltEnd::Head,
                    node: tee,
                    port: FAULT_PORT, // the reserved NON-spatial sentinel, passed directly
                })
                .err(),
            Some(CommandError::InvalidDock),
            "a Head (load) dock to the non-spatial FAULT_PORT is role-incompatible"
        );
        assert_eq!(session.edit_log().len(), log_len, "no record produced");
        assert_eq!(snapshot(session.core()), before, "state byte-identical (SC#2)");
    }

    #[test]
    fn fault_dock_non_spatial_tail_offload_to_fault_port_still_accepts() {
        // WR-04 companion: the Head-load guard must NOT regress the valid offload path —
        // a TAIL (offload) dock to the non-spatial FAULT_PORT sentinel still accepts and
        // freezes the link on FAULT_PORT (mirrors the preserved-exemption test, asserting
        // the added `else if Head` branch left the Tail case untouched).
        // RETARGETED in phase 71 from the ROUTER to the TEE, with its companion above
        // and for the same reason: the Router now resolves the sentinel SPATIALLY, so on
        // a Router this would be measuring the geometry check rather than the exemption.
        let mut session = GridSession::new(7);
        let tee = place_tee(&mut session, 0, 0);
        let (_, tee_ports) = port_catalog(machine_kind::TEE);
        assert!(
            tee_ports.iter().all(|p| p.role != Role::Fault),
            "the TEE must still be nub-less for this to exercise the NON-SPATIAL branch"
        );
        let belt = draw_belt(&mut session, vec![(20, 20), (21, 20)]);
        let (tee_id, belt_id) = {
            let lk = session.view().lookup(session.core());
            (
                lk.resolve(tee).expect("tee id"),
                lk.resolve(belt).expect("belt id"),
            )
        };
        let rec = session
            .apply(GridCommand::Dock {
                belt,
                endpoint: fabrico_protocol::BeltEnd::Tail,
                node: tee,
                port: FAULT_PORT,
            })
            .expect("a Tail (offload) dock to the non-spatial FAULT_PORT is still accepted");
        assert_eq!(
            rec.op,
            EditOp::Dock {
                belt: belt_id,
                endpoint: BeltEnd::Tail,
                node: tee_id,
                port: FAULT_PORT,
            },
            "the offload exemption freezes the dock on FAULT_PORT without geometry"
        );
    }

    #[test]
    fn drawbelt_clear_path_freezes_resolved_tiles_equal_to_route() {
        // A clear L-path over an empty grid accepts and freezes EditOp::DrawBelt
        // whose tiles are byte-identical to route(cells) — preview==commit proven
        // ACROSS the command boundary (the commit path resolves via the SAME route()).
        use crate::route::route;
        let core = Core::genesis(header());
        let view = GridView::new();
        let cells = vec![(0, 0), (1, 0), (1, 1)];
        let rec = validate_normalize(
            &view.lookup(&core),
            GridCommand::DrawBelt { cells: cells.clone() },
        )
        .expect("a clear drawn path is accepted");
        let expected = route(&cells).expect("route resolves the same cells");
        assert_eq!(
            only_op(&rec),
            EditOp::DrawBelt { tiles: expected },
            "the committed tiles equal route(cells) — preview==commit across the boundary"
        );
    }

    #[test]
    fn drawbelt_crossing_occupied_cell_rejects_atomically() {
        // BELT-06: a belt cannot overlap a machine body. A SOURCE occupies (1,0); a
        // drawn path through (1,0) rejects the WHOLE belt with FootprintCollision
        // (taxonomy reuse) and produces NOTHING (state byte-identical, SC#2).
        let mut session = GridSession::new(7);
        session
            .apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 1, cell_y: 0 })
            .expect("place the obstacle at (1,0)");
        let before = snapshot(session.core());
        assert_eq!(
            session
                .apply(GridCommand::DrawBelt { cells: vec![(0, 0), (1, 0), (2, 0)] })
                .err(),
            Some(CommandError::FootprintCollision),
            "a belt crossing an occupied cell is rejected (BELT-06)"
        );
        assert_eq!(
            snapshot(session.core()),
            before,
            "the rejected DrawBelt leaves the Core byte-identical (SC#2)"
        );
    }

    #[test]
    fn drawbelt_self_crossing_path_rejects_route_error_and_produces_nothing() {
        // A malformed (self-crossing) drawn path surfaces CommandError::Route wrapping
        // the typed RouteError::SelfCrossing and produces NO record (no panic, no guess).
        use crate::route::RouteError;
        let mut session = GridSession::new(7);
        let before = snapshot(session.core());
        let log_len_before = session.edit_log().len();
        assert_eq!(
            session
                .apply(GridCommand::DrawBelt {
                    cells: vec![(0, 0), (1, 0), (1, 1), (0, 1), (0, 0)],
                })
                .err(),
            Some(CommandError::Route(RouteError::SelfCrossing)),
            "a self-crossing drawn path rejects with a typed RouteError"
        );
        assert_eq!(session.edit_log().len(), log_len_before, "no record produced");
        assert_eq!(snapshot(session.core()), before, "state byte-identical (SC#2)");
    }

    #[test]
    fn drawbelt_exceeding_max_tiles_rejects_and_short_belt_round_trips() {
        // CR-02: the command layer's acceptance envelope MUST match the snapshot/edit-
        // log round-trip envelope. `route()` only rejects self-crossing paths, so a
        // non-crossing path LONGER than `MAX_BELT_TILES` (1024) would otherwise fold
        // into a belt the snapshot trust gate (`BeltTilesTooMany`) then REJECTS on
        // restore — a live Core that fails its own save/load. We cap the tile COUNT
        // before producing the record, mirroring the snapshot/upcast bound.
        use fabrico_core::edit::MAX_BELT_TILES;

        // A straight horizontal line spanning the full grid extent
        // [-512, 512] on x at y=0 is exactly 1025 = MAX_BELT_TILES + 1 in-bounds,
        // non-crossing cells — accepted by `route()` but over the tile cap.
        let over: Vec<(i32, i32)> = (GRID_MIN..=GRID_MAX).map(|x| (x, 0)).collect();
        assert_eq!(
            over.len(),
            MAX_BELT_TILES as usize + 1,
            "the test path is exactly one tile over the cap"
        );
        let mut session = GridSession::new(7);
        let before = snapshot(session.core());
        let log_len_before = session.edit_log().len();
        assert_eq!(
            session.apply(GridCommand::DrawBelt { cells: over }).err(),
            Some(CommandError::BeltTooLong),
            "a DrawBelt of MAX_BELT_TILES + 1 cells is rejected (envelope parity)"
        );
        assert_eq!(session.edit_log().len(), log_len_before, "no record produced");
        assert_eq!(snapshot(session.core()), before, "rejected DrawBelt is byte-identical (SC#2)");

        // An ACCEPTED DrawBelt (at the cap) yields a Core that round-trips
        // restore(snapshot(core)) — proving the accepted envelope is restorable.
        let max_line: Vec<(i32, i32)> = (GRID_MIN..GRID_MAX).map(|x| (x, 0)).collect();
        assert_eq!(max_line.len(), MAX_BELT_TILES as usize, "exactly the cap");
        session
            .apply(GridCommand::DrawBelt { cells: max_line })
            .expect("a DrawBelt of exactly MAX_BELT_TILES cells is accepted");
        let bytes = snapshot(session.core());
        let restored = fabrico_core::snapshot::restore(&bytes)
            .expect("an accepted DrawBelt always yields a snapshot the trust gate accepts");
        assert_eq!(
            bytes,
            snapshot(&restored),
            "the accepted long belt round-trips restore(snapshot(core)) byte-identically"
        );
    }

    #[test]
    fn rotate_collision_bounds_1x1_noop_and_legal_accept() {
        // FOOT-02: the Rotate arm enforces an anchor-preserving pivot — overlap with
        // ANY OTHER node rejects (own cells excluded), off-grid on ANY rotated cell
        // rejects (Pitfall 5), a 1×1 is always accepted (a no-op), and a legal
        // rotation freezes the correct new_rot/old_rot; every reject is byte-identical.

        // (a) Occupied reject: a 2×3 exemplar A at (0,0) [x{0,1} y{0,1,2}]. A 1×1
        //     SOURCE B at (2,0) is free under A's rot0; rotating A +1 (CW) -> 3×2
        //     [x{0,1,2} y{0,1}] would claim (2,0) held by B -> FootprintCollision.
        let mut session = GridSession::new(7);
        let a = place_exemplar(&mut session, 0, 0);
        session
            .apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 2, cell_y: 0 })
            .expect("place the 1×1 obstacle B at (2,0)");
        let before = snapshot(session.core());
        assert_eq!(
            session.apply(GridCommand::Rotate { node: a, ccw: false }).err(),
            Some(CommandError::RotateBlocked),
            "a rotation overlapping ANOTHER node's cell is rejected (own cells excluded)"
        );
        assert_eq!(
            snapshot(session.core()),
            before,
            "the rejected rotate leaves the Core byte-identical (SC#2)"
        );

        // (b) Off-grid reject (Pitfall 5): a 2×3 at (511,0) fits rot0 [x{511,512}] but
        //     rot1 -> 3×2 spills to x=513 past GRID_MAX=512 -> OutOfBounds.
        let mut session2 = GridSession::new(7);
        let h = place_exemplar(&mut session2, GRID_MAX - 1, 0);
        let before2 = snapshot(session2.core());
        assert_eq!(
            session2.apply(GridCommand::Rotate { node: h, ccw: false }).err(),
            Some(CommandError::OutOfBounds),
            "a rotated body cell past GRID_MAX is rejected (EVERY rotated cell bounds-checked)"
        );
        assert_eq!(
            snapshot(session2.core()),
            before2,
            "the rejected rotate leaves the Core byte-identical (SC#2)"
        );

        // (c) 1×1 no-op accept: a SOURCE (1×1) rotates with the single anchor cell
        //     owned by itself -> always accepted, freezing new_rot=1, old_rot=0.
        let mut session3 = GridSession::new(7);
        session3
            .apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 50, cell_y: 50 })
            .expect("place a 1×1 source");
        let sid = *session3.core().last_tick.placed.last().expect("source minted");
        let sh = session3.view().handle_of(sid).expect("source handle");
        let rec = session3
            .apply(GridCommand::Rotate { node: sh, ccw: false })
            .expect("a 1×1 rotate is accepted (no-op on occupancy)");
        assert_eq!(
            rec.op,
            EditOp::Rotate { node: sid, new_rot: 1, old_rot: 0 },
            "a 1×1 CW rotate freezes new_rot=1, old_rot=0"
        );

        // (d) Legal accept into free space with the CCW direction: a 2×3 exemplar at
        //     (100,100) rotates CCW -> new_rot = (0 + 3) & 3 = 3, old_rot = 0.
        let mut session4 = GridSession::new(7);
        session4
            .apply(GridCommand::Place { kind: machine_kind::ROUTER, cell_x: 100, cell_y: 100 })
            .expect("place the exemplar in free space");
        let lid = *session4.core().last_tick.placed.last().expect("router minted");
        let lh = session4.view().handle_of(lid).expect("router handle");
        let rec = session4
            .apply(GridCommand::Rotate { node: lh, ccw: true })
            .expect("a legal CCW rotate into free space is accepted");
        assert_eq!(
            rec.op,
            EditOp::Rotate { node: lid, new_rot: 3, old_rot: 0 },
            "a CCW rotate from rot0 freezes new_rot=3 (≡ -1 mod 4), old_rot=0"
        );
    }

    // ---- Phase 12-03: the undo/redo projection kernel ----

    /// A genesis session carries an empty projection: nothing to undo or redo.
    #[test]
    fn projection_genesis_is_empty() {
        let session = GridSession::new(7);
        assert!(session.undoable_stack().is_empty(), "no undoable actions at genesis");
        assert_eq!(session.redo_cursor(), 0, "cursor is 0 at genesis");
        assert!(session.id_translation().is_empty(), "xlate is empty at genesis");
        assert!(!session.can_undo(), "genesis cannot undo");
        assert!(!session.can_redo(), "genesis cannot redo");
        assert_eq!(session.undo_target(), None, "no undo target at genesis");
        assert_eq!(session.redo_target(), None, "no redo target at genesis");
    }

    /// After N distinct normal applies the cursor sits at the top: N undoable, none
    /// redoable, and every minted id maps to itself in `xlate` (identity until a
    /// re-mint).
    #[test]
    fn projection_after_n_normal_applies() {
        let mut session = GridSession::new(7);
        let cells = [(0, 0), (2, 0), (4, 0)];
        for (x, y) in cells {
            session
                .apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: x, cell_y: y })
                .expect("place at a free cell");
        }
        assert_eq!(session.undoable_stack().len(), 3, "three distinct actions are undoable");
        assert_eq!(session.redo_cursor(), 3, "cursor sits at the top (all live)");
        assert!(session.can_undo(), "can undo after applies");
        assert!(!session.can_redo(), "nothing undone yet -> cannot redo");
        assert_eq!(session.undoable_stack(), &[0, 1, 2], "actions in monotonic append order");
        assert_eq!(session.undo_target(), Some(2), "undo would target the top action");
        // Every placed node maps to itself (identity).
        assert_eq!(session.id_translation().len(), 3, "three minted ids in xlate");
        for (orig, current) in session.id_translation() {
            assert_eq!(orig, current, "xlate is identity until a re-mint");
        }
    }

    /// A move coalesces Delete+Place under ONE shared action -> ONE undo step,
    /// spanning two ticks but folding to a single undoable entry.
    #[test]
    fn projection_coalesces_a_move_into_one_action() {
        let mut session = GridSession::new(7);
        session
            .apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 0, cell_y: 0 })
            .expect("place a source");
        let id = *session.core().last_tick.placed.last().expect("source minted");
        let handle = session.view().handle_of(id).expect("source handle");
        session
            .move_machine(handle, machine_kind::SOURCE, 5, 5)
            .expect("move the source");
        // Two LOGICAL actions: the original place (0) + the move (1, Delete+Place).
        assert_eq!(session.undoable_stack(), &[0, 1], "the move is ONE undo step");
        assert_eq!(session.redo_cursor(), 2, "both live");
    }

    /// `replay(seed, log)` rebuilds a session whose core snapshot AND projection are
    /// byte-equal to the live session that issued the same records (UNDO-03).
    #[test]
    fn replay_rebuilds_equal_core_and_projection() {
        let mut live = GridSession::new(0xFAB);
        // 17-02: the node→node Wire that previously connected these was removed; the
        // replay-equivalence contract holds over the remaining Place records (belt
        // topology via DrawBelt + Dock is exercised by the drawbelt_*/dock_* tests).
        live.apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 0, cell_y: 0 })
            .expect("place source");
        live.apply(GridCommand::Place { kind: machine_kind::SINK, cell_x: 3, cell_y: 0 })
            .expect("place sink");

        let rebuilt = GridSession::replay(0xFAB, live.edit_log());
        assert_eq!(
            snapshot(rebuilt.core()),
            snapshot(live.core()),
            "replay reproduces a byte-identical core snapshot"
        );
        assert_eq!(rebuilt.undoable_stack(), live.undoable_stack(), "equal undoable stack");
        assert_eq!(rebuilt.redo_cursor(), live.redo_cursor(), "equal cursor");
        assert_eq!(rebuilt.id_translation(), live.id_translation(), "equal xlate");
    }

    /// `replay` over an empty log reconstructs a genesis-equivalent session.
    #[test]
    fn replay_of_an_empty_log_is_genesis() {
        let rebuilt = GridSession::replay(7, &[]);
        assert!(rebuilt.undoable_stack().is_empty(), "empty undoable");
        assert_eq!(rebuilt.redo_cursor(), 0, "cursor 0");
        assert_eq!(rebuilt.sequence, 0, "sequence high-water is 0");
        assert_eq!(rebuilt.action, 0, "action high-water is 0");
    }

    /// An UNDO marker group decrements the cursor; a following REDO marker group
    /// increments it; a NORMAL group AFTER an undo truncates the redo tail (Q1.1).
    /// Driven by hand-appending marker groups (the real driver lands in 12-04), the
    /// projection still reconstructs purely from the log.
    #[test]
    fn projection_folds_undo_redo_markers_and_truncates_on_fresh_action() {
        let mut session = GridSession::new(7);
        // Two normal actions (0, 1).
        session
            .apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 0, cell_y: 0 })
            .expect("place 0");
        session
            .apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 2, cell_y: 0 })
            .expect("place 1");

        // Hand-append an UNDO{target: 1} marker group (one record, one tick, one new
        // action) to simulate undoing action 1, then reconstruct from the log.
        append_marker(&mut session, EditOp::Undo { target_action: 1 });
        assert_eq!(session.redo_cursor(), 1, "undo steps the cursor back to 1");
        assert_eq!(session.undoable_stack(), &[0, 1], "the stack is retained (redoable tail)");
        assert!(session.can_redo(), "action 1 is now redoable");
        assert_eq!(session.redo_target(), Some(1), "redo would target action 1");

        // REDO{target: 1} steps the cursor forward again.
        append_marker(&mut session, EditOp::Redo { target_action: 1 });
        assert_eq!(session.redo_cursor(), 2, "redo steps the cursor forward to 2");
        assert!(!session.can_redo(), "nothing redoable after redo");

        // Undo again, then a FRESH normal action: the redo tail is killed (Q1.1).
        append_marker(&mut session, EditOp::Undo { target_action: 1 });
        assert_eq!(session.redo_cursor(), 1, "undone again");
        session
            .apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 8, cell_y: 0 })
            .expect("a fresh normal action");
        assert_eq!(
            session.undoable_stack().len(),
            2,
            "a fresh action truncates the redoable tail then pushes (Q1.1 linear history)"
        );
        assert!(!session.can_redo(), "the redo stack was invalidated by the fresh action");
    }

    /// Append a fold-NOOP lineage marker as its own action group (one record, one
    /// tick) directly onto the session's log + core — the in-test stand-in for the
    /// 12-04 driver, exercising the reconstruction fold over marker groups.
    fn append_marker(session: &mut GridSession, op: EditOp) {
        let record = EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: session.sequence,
            tick: session.core.tick,
            action: session.action,
            op,
        };
        session.sequence += 1;
        session.action += 1;
        session.edit_log.push(record);
        session
            .core
            .advance_edits(std::slice::from_ref(session.edit_log.last().expect("pushed")), &[]);
        session.view.apply_tick(&session.core);
        session.reconstruct_projection();
    }

    // ---- Phase 12-04: the real GridCommand::Undo/Redo driver (smoke) ----

    /// Undo of a single Place appends a marker + a Delete under one new action, the
    /// node is gone, the log only GREW (append-only), and the cursor stepped back.
    #[test]
    fn driver_undo_of_place_removes_node_and_is_append_only() {
        let mut session = GridSession::new(7);
        session
            .apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 0, cell_y: 0 })
            .expect("place a source");
        let id = *session.core().last_tick.placed.last().expect("source minted");
        assert!(session.core().state.occupied((0, 0)).is_some(), "node placed");
        let len_before = session.edit_log().len();

        session.apply(GridCommand::Undo).expect("undo the place");

        assert!(session.core().state.occupied((0, 0)).is_none(), "node gone after undo");
        assert!(
            session.edit_log().len() > len_before,
            "the log GREW (marker + Delete appended) — strictly append-only"
        );
        // The first appended record is the lineage marker; the node id is no longer live.
        assert!(session.view().handle_of(id).is_none(), "the undone node has no live handle");
        assert!(!session.can_undo(), "nothing left to undo");
        assert!(session.can_redo(), "the place is now redoable");
    }

    /// Undo then redo of a Place restores a functionally-equivalent node (re-minted
    /// under a fresh id — the accepted FLAG) and leaves the cursor at the top.
    #[test]
    fn driver_undo_then_redo_place_restores_node() {
        let mut session = GridSession::new(7);
        session
            .apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 4, cell_y: 4 })
            .expect("place a source");
        session.apply(GridCommand::Undo).expect("undo");
        assert!(session.core().state.occupied((4, 4)).is_none(), "gone after undo");

        session.apply(GridCommand::Redo).expect("redo");
        assert!(session.core().state.occupied((4, 4)).is_some(), "restored after redo");
        assert!(session.can_undo(), "the redone action is undoable again");
        assert!(!session.can_redo(), "nothing left to redo");
    }

    /// Empty undo/redo stacks reject TYPED with the core snapshot byte-identical
    /// (T-12-06 — never a panic / cursor underflow).
    #[test]
    fn driver_empty_stacks_reject_typed_and_byte_identical() {
        let mut session = GridSession::new(7);
        let genesis = snapshot(session.core());
        assert_eq!(
            session.apply(GridCommand::Undo).err(),
            Some(CommandError::NothingToUndo),
            "undo on genesis is NothingToUndo"
        );
        assert_eq!(
            session.apply(GridCommand::Redo).err(),
            Some(CommandError::NothingToRedo),
            "redo with a full cursor is NothingToRedo"
        );
        assert_eq!(snapshot(session.core()), genesis, "rejects leave the core byte-identical");
        assert!(session.edit_log().is_empty(), "no record produced by either reject");
    }

    /// DEMO-05 / D-10 (plan 85-06): the history seal is the UNDO FLOOR. Two Places then a
    /// seal: nothing is undoable, Undo answers `NothingToUndo` having appended nothing, and
    /// the floor reads 2 (the cursor at the seal). A Place after the seal is undoable, and
    /// one undo takes the board back to the floor and no further.
    #[test]
    fn seal_history_makes_undo_report_nothing_to_undo() {
        let mut session = GridSession::new(7);
        for x in [0, 4] {
            session
                .apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: x, cell_y: 0 })
                .expect("place a source");
        }
        assert!(session.can_undo(), "non-vacuity: two Places are undoable before the seal");
        let tick_before = session.core().tick;
        session.seal_history().expect("seal the history");
        assert_eq!(session.core().tick, tick_before + 1, "the seal folds in one tick, like apply");
        assert_eq!(session.undo_floor(), 2, "the floor is the cursor at the seal");
        assert!(!session.can_undo(), "nothing below the seal is undoable");
        let sealed_log = session.edit_log().len();
        let sealed_grid = snapshot(session.core());
        assert_eq!(
            session.apply(GridCommand::Undo).err(),
            Some(CommandError::NothingToUndo),
            "Undo at the floor is NothingToUndo"
        );
        assert_eq!(session.resolve_undo().err(), Some(CommandError::NothingToUndo), "and so is the host's resolve");
        assert_eq!(session.edit_log().len(), sealed_log, "the refused Undo appended nothing");
        assert_eq!(snapshot(session.core()), sealed_grid, "and changed no core byte");

        session
            .apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 8, cell_y: 0 })
            .expect("a Place after the seal");
        assert!(session.can_undo(), "the user's own edit above the floor is undoable");
        session.apply(GridCommand::Undo).expect("undo the edit above the floor");
        assert!(session.core().state.occupied((8, 0)).is_none(), "the edit above the floor is gone");
        assert!(session.core().state.occupied((4, 0)).is_some(), "the scene below the floor stays");
        assert!(!session.can_undo(), "Undo is greyed again at the floor");
        assert!(session.can_redo(), "and the undone edit is redoable");
        assert!(!session.undo_floor_breached(), "a log this build writes never breaches its floor");
    }

    /// T-85-14 (plan 85-06): a log whose Undo marker reaches under the seal is a BREACH,
    /// in both shapes a hand-edited file can hold. The marker is appended to a real log as
    /// a forged file would carry it (fresh action, next sequence, next tick).
    #[test]
    fn a_forged_undo_under_the_floor_is_a_breach() {
        fn forged_undo(log: &[EditRecord], target_action: u64) -> Vec<EditRecord> {
            let last = log.last().expect("a real log to forge onto");
            let mut forged = log.to_vec();
            forged.push(EditRecord {
                schema_version: EDIT_SCHEMA_VERSION,
                partition: 0,
                sequence: last.sequence + 1,
                tick: last.tick + 1,
                action: log.iter().map(|r| r.action).max().unwrap_or(0) + 1,
                op: EditOp::Undo { target_action },
            });
            forged
        }
        // Shape 1, [Place, Seal, Undo(Place)]: the cursor falls under the floor.
        let mut session = GridSession::new(7);
        session
            .apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 0, cell_y: 0 })
            .expect("place A");
        let a = session.edit_log()[0].action;
        session.seal_history().expect("seal");
        let honest = GridSession::replay(7, session.edit_log());
        assert!(!honest.undo_floor_breached(), "non-vacuity: the honest sealed log is no breach");
        let forged = GridSession::replay(7, &forged_undo(session.edit_log(), a));
        assert!(forged.undo_floor_breached(), "an Undo of the sealed Place is a breach");
        assert_eq!((forged.undo_floor(), forged.redo_cursor()), (1, 0), "the floor is past the cursor");

        // Shape 2, [Place A, Seal, Place B, Undo(A)]: a later action keeps the cursor at the
        // floor, so only the marker's target position shows the breach.
        session
            .apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 4, cell_y: 0 })
            .expect("place B");
        let forged = GridSession::replay(7, &forged_undo(session.edit_log(), a));
        assert_eq!(forged.redo_cursor(), forged.undo_floor(), "the cursor itself stays at the floor");
        assert!(forged.undo_floor_breached(), "an Undo naming an action under the floor is a breach");
    }

    /// CR-01: a FORGED/corrupted log loaded via the pub `replay` primitive can carry a
    /// minting op that folds to a NO-OP — here a `Place` with an UNKNOWN `kind` byte
    /// (200), which decode never validates and `fold_place` ignores, minting nothing —
    /// yet reconstruction still makes its action a NORMAL undoable group with an EMPTY
    /// minted set. The reverse Undo walk's `mint_idx` (one step per minting op) would
    /// underflow past 0 and index `minted` out of bounds. `apply(Undo)` MUST instead
    /// surface a typed `Malformed` reject and leave the core byte-identical — never a
    /// panic (the phase no-panic-on-hostile-decode mandate, mirroring the `upcast`
    /// forged-record tests).
    #[test]
    fn driver_undo_of_forged_noop_minting_op_rejects_typed_never_panics() {
        // One hand-built record: a Place with an out-of-range kind, under action 0,
        // folded at genesis tick 0. It survives load (kind is never decode-validated)
        // and folds to nothing, so action 0 is undoable but minted zero nodes.
        let forged = vec![EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 0,
            tick: 0,
            action: 0,
            op: EditOp::Place { kind: 200, cell_x: 0, cell_y: 0, w: 1, h: 1, ports: Vec::new(), rot: 0 },
        }];

        let mut session = GridSession::replay(0xFAB, &forged);
        let before = snapshot(session.core());
        assert!(
            session.can_undo(),
            "the no-op-folding place still reconstructs as an undoable group"
        );

        assert_eq!(
            session.apply(GridCommand::Undo).err(),
            Some(CommandError::UndoDoesNotFit),
            "a structurally-inconsistent forged group rejects TYPED, never panics"
        );
        assert_eq!(
            snapshot(session.core()),
            before,
            "the typed reject left the core byte-identical (nothing appended/folded)"
        );
    }

    /// A move (Delete+Place under one shared action) reverses in ONE undo call: the
    /// machine returns to its old cell and the new cell frees (UNDO-02 coalescing).
    #[test]
    fn driver_move_undoes_in_one_step() {
        let mut session = GridSession::new(7);
        session
            .apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 0, cell_y: 0 })
            .expect("place a source");
        let id = *session.core().last_tick.placed.last().expect("source minted");
        let handle = session.view().handle_of(id).expect("source handle");
        session.move_machine(handle, machine_kind::SOURCE, 9, 9).expect("move the source");
        assert!(session.core().state.occupied((9, 9)).is_some(), "moved to new cell");
        assert!(session.core().state.occupied((0, 0)).is_none(), "old cell freed");

        // ONE undo call reverses BOTH legs of the move.
        session.apply(GridCommand::Undo).expect("undo the move");
        assert!(session.core().state.occupied((0, 0)).is_some(), "machine back at the old cell");
        assert!(session.core().state.occupied((9, 9)).is_none(), "new cell freed again");
        // The move undid in ONE step; the ORIGINAL place (action 0) is still undoable.
        assert!(session.can_undo(), "the original place remains undoable after the move undo");
        assert!(session.can_redo(), "the move is now redoable");
    }

    // ─── BELT-02 / D-68-07 (68-04): the HEADLESS twin of the one-action-id run ───
    //
    // Placed beside the three shipped precedents deliberately, so a later reader finds
    // all four together: `place_router_preset_is_a_single_undoable_action` (whole-group
    // undo), `projection_coalesces_a_move_into_one_action` (the only one of the three
    // that asserts an action-id COUNT) and `driver_move_undoes_in_one_step` (the
    // can_undo/can_redo tail). None of the three covers a belt run.
    //
    // AND NONE OF THEM SAYS ANYTHING ABOUT THE SHIPPED APP. See the helper's docblock:
    // this seam is reachable from tests and from `fabrico-scenario` only. The live
    // equivalent is `Host::enqueue_action_group`, asserted in
    // `crates/fabrico-host/tests/belt_run_pace.rs`.

    /// Three separate belts at the crate default pace, and their dense handles.
    fn three_belt_run(session: &mut GridSession) -> (Vec<NodeId>, Vec<u64>) {
        let mut ids = Vec::new();
        let mut handles = Vec::new();
        for row in [1, 3, 5] {
            let (id, handle) = belt(session, vec![(1, row), (2, row)]);
            ids.push(id);
            handles.push(handle);
        }
        (ids, handles)
    }

    /// A pace that is NOT the crate default, so every assertion below can fail.
    const RUN_PACE: u32 = 10;

    /// Test 1: one call sets all three, and ONE `Undo` restores all three.
    #[test]
    fn set_belt_run_pace_sets_every_belt_and_one_undo_restores_them_all() {
        let mut session = GridSession::new(3);
        let (ids, handles) = three_belt_run(&mut session);
        let before: Vec<u32> = ids.iter().map(|id| belt_pace(&session, *id)).collect();
        assert!(
            before.iter().all(|p| *p != RUN_PACE),
            "the written pace must differ from the default, or this case cannot fail",
        );

        session
            .set_belt_run_pace(&handles, RUN_PACE)
            .expect("a three-belt run at an in-range pace is accepted");
        for id in &ids {
            assert_eq!(belt_pace(&session, *id), RUN_PACE, "{id:?} folded the new pace");
        }

        session.apply(GridCommand::Undo).expect("undo the run");
        for (id, was) in ids.iter().zip(&before) {
            assert_eq!(
                belt_pace(&session, *id),
                *was,
                "{id:?} is back at its previous pace after ONE undo",
            );
        }
    }

    /// Test 2: the CARDINALITY of the distinct `action` set is 1.
    ///
    /// Deliberately not "three records exist" and not "the three belts hold the new
    /// pace": both stay fully GREEN under the naive mutation (three separate
    /// `self.apply` calls) that breaks undo. Only the cardinality can see it, which is
    /// why `projection_coalesces_a_move_into_one_action` is the precedent this copies
    /// and not the other two.
    #[test]
    fn a_belt_run_writes_its_records_under_exactly_one_action_id() {
        let mut session = GridSession::new(3);
        let (_ids, handles) = three_belt_run(&mut session);
        let before_len = session.edit_log().len();

        session.set_belt_run_pace(&handles, RUN_PACE).expect("run accepted");

        let configures: Vec<&EditRecord> = session.edit_log()[before_len..]
            .iter()
            .filter(|r| matches!(r.op, EditOp::Configure { .. }))
            .collect();
        assert_eq!(configures.len(), 3, "one Configure record per belt in the run");
        let actions: std::collections::BTreeSet<u64> =
            configures.iter().map(|r| r.action).collect();
        assert_eq!(
            actions.len(),
            1,
            "THE WHOLE POINT: N belts, ONE action id, so ONE undo. Got actions {actions:?}",
        );
        assert_eq!(
            session.undoable_stack().len(),
            4,
            "three DrawBelts plus the run: the run is ONE entry, not three",
        );
    }

    /// Test 3: the `driver_move_undoes_in_one_step` tail, applied to a run.
    #[test]
    fn a_belt_run_leaves_the_undo_and_redo_cursors_where_one_step_leaves_them() {
        let mut session = GridSession::new(3);
        let (_ids, handles) = three_belt_run(&mut session);
        session.set_belt_run_pace(&handles, RUN_PACE).expect("run accepted");
        assert!(session.can_undo(), "an applied run is undoable");
        session.apply(GridCommand::Undo).expect("undo the run");
        assert!(session.can_redo(), "the undone run is redoable: the cursor moved ONE step");
        assert!(
            session.can_undo(),
            "the three DrawBelts below it are still undoable, so the run was one step",
        );
    }

    /// Test 4 (Pitfall 4): a run refused on its SECOND belt still advances the shared
    /// id, so the next unrelated action is a SEPARATE undo step.
    ///
    /// The assertion is on the NEXT action's ID, not on the returned error. Asserting
    /// only that the run rejected cannot see the fusion at all: with the advance
    /// removed, the run still returns `Err`, the first belt still folded, and the next
    /// `apply()` silently joins it.
    #[test]
    fn a_refused_belt_run_still_advances_the_action_id() {
        let mut session = GridSession::new(3);
        let (ids, handles) = three_belt_run(&mut session);
        // A handle no live node answers to, in the SECOND position: the first leg folds
        // and the second rejects.
        let with_a_dead_middle = [handles[0], 9_999, handles[2]];
        assert_eq!(
            session.set_belt_run_pace(&with_a_dead_middle, RUN_PACE),
            Err(CommandError::UnknownNode),
            "a stale handle rejects the run at the leg that names it",
        );
        assert_eq!(
            belt_pace(&session, ids[0]),
            RUN_PACE,
            "the leg BEFORE the rejection folded - this helper is not a transaction",
        );
        let refused_action = session
            .edit_log()
            .last()
            .expect("the first leg appended a record")
            .action;

        // A completely unrelated action, right after.
        let (_next_id, _next_handle) = belt(&mut session, vec![(8, 8), (9, 8)]);
        let next_action = session
            .edit_log()
            .last()
            .expect("the DrawBelt appended a record")
            .action;
        assert_ne!(
            next_action, refused_action,
            "the next unrelated action must get a FRESH id. Equal ids fuse two distinct \
             logical actions into ONE undo step, so a single Ctrl+Z would take back the \
             belt the user just drew AND the pace change before it",
        );
    }

    /// Test 5: an EMPTY run is a typed refusal, not a silent no-op, and it burns no id.
    #[test]
    fn an_empty_belt_run_is_a_typed_refusal_that_consumes_no_action_id() {
        let mut session = GridSession::new(3);
        let (_ids, handles) = three_belt_run(&mut session);
        let before_len = session.edit_log().len();
        assert_eq!(
            session.set_belt_run_pace(&[], RUN_PACE),
            Err(CommandError::Malformed),
            "an empty run is a typed refusal - the same tag the LIVE arm returns for it",
        );
        assert_eq!(session.edit_log().len(), before_len, "nothing was appended");

        // The id was NOT consumed, asserted through behaviour rather than by reading the
        // private counter: a run applied now is still exactly ONE action.
        session.set_belt_run_pace(&handles, RUN_PACE).expect("run accepted");
        let actions: std::collections::BTreeSet<u64> = session.edit_log()[before_len..]
            .iter()
            .map(|r| r.action)
            .collect();
        assert_eq!(actions.len(), 1, "the refused empty run left the counter alone");
    }

    /// Test 6: THE SHARED ACTION ID RIDES THE PERSISTED LOG.
    ///
    /// Every other one-action-id board in this phase is in-memory, and the user
    /// reloads. `SC2` and `BELT-02` both say the command saves, loads, undoes and
    /// replays, and the phase otherwise proves those separately: the pace VALUE survives
    /// a load (the `D-68-17` pair) and the shared id groups an undo (tests 1 to 3), but
    /// nothing else asserts the two TOGETHER. If the id did not ride the persisted log,
    /// a user who reloads and presses undo once gets ONE belt back out of three.
    ///
    /// The generic property is already proved for the MOVE shape by
    /// `crates/fabrico-command/tests/undo_save_load.rs`'s multi-record property test,
    /// which is why this is one leg copying that round-trip shape rather than new
    /// machinery. It asserts all three belts restored, never that the undo returned
    /// `Ok`.
    #[test]
    fn set_belt_run_pace_survives_a_save_and_one_undo_on_the_reloaded_session() {
        let mut live = GridSession::new(3);
        let (_ids, handles) = three_belt_run(&mut live);
        let before = DEFAULT_TICKS_PER_SLOT.get();
        assert_ne!(before, RUN_PACE, "the run must change something");
        live.set_belt_run_pace(&handles, RUN_PACE).expect("run accepted");

        // THE SAVE, through the real on-disk representation: `ProjectFile` bundles
        // exactly `Vec<EditRecord>` and postcard is the on-disk format, so this is the
        // same byte path `save_project` / `load_project` take.
        let bytes = postcard::to_allocvec(live.edit_log()).expect("the edit log encodes");
        let records: Vec<EditRecord> =
            postcard::from_bytes(&bytes).expect("the saved log decodes");
        let mut loaded = GridSession::replay(3, &records);

        let loaded_belts: Vec<NodeId> = loaded
            .core()
            .state
            .node_ids()
            .filter(|id| matches!(loaded.core().state.node(*id), Some(Node::Belt(_))))
            .collect();
        assert_eq!(loaded_belts.len(), 3, "the reloaded board holds all three belts");
        for id in &loaded_belts {
            assert_eq!(belt_pace(&loaded, *id), RUN_PACE, "the reload folded the run");
        }

        // ONE Undo on the LOADED session.
        loaded.apply(GridCommand::Undo).expect("undo on the reloaded session");
        let after: Vec<u32> = loaded
            .core()
            .state
            .node_ids()
            .filter(|id| matches!(loaded.core().state.node(*id), Some(Node::Belt(_))))
            .map(|id| belt_pace(&loaded, id))
            .collect();
        assert_eq!(
            after,
            vec![before; 3],
            "ALL THREE belts are restored by ONE undo on the RELOADED session. Getting \
             one back out of three here is what a shared id that did not ride the \
             persisted log looks like to a user",
        );
    }

    /// The Pitfall-5 cost MEASUREMENT, kept runnable rather than only written down.
    ///
    /// `apply_under_action` calls `reconstruct_projection` on EVERY call and that is
    /// O(history), so a run of N is O(N x history). `#[ignore]`d because a wall-clock
    /// assertion is flake in CI and this is a measurement, not a gate; run it with
    /// `cargo test -p fabrico-command --lib -- --ignored --nocapture belt_run_pace_projection`.
    /// The figure it printed for plan 68-04 is recorded in `68-04-SUMMARY.md` and quoted
    /// in the helper's `# Cost` section.
    #[test]
    #[ignore = "a wall-clock measurement, not a gate"]
    // THE ONE PLACE IN THIS CRATE THAT READS A WALL CLOCK, and the allow is scoped to
    // this function so it cannot spread. The workspace bans `Instant` because wall clock
    // is non-deterministic and sim time is `current_tick` (CORE-03/05, `clippy.toml`).
    // Nothing here is sim code: it is an `#[ignore]`d measurement that folds no tick and
    // is never run by a gate - the same standing this crate already grants the
    // `#[ignore]`d golden freezers in `wire_golden.rs` and `route_golden.rs`. The
    // alternative was to leave the O(N x history) cost ASSUMED, which research
    // assumption A2 explicitly says not to do.
    #[allow(clippy::disallowed_types, clippy::disallowed_methods)]
    fn belt_run_pace_projection_cost_at_the_upper_end() {
        /// 200 Places plus 256 two-tile belts: a non-trivial edit log, so
        /// `reconstruct_projection` has real history to re-fold on every one of the N
        /// calls. Rebuilt per measurement point so the history is IDENTICAL at each
        /// one - otherwise the curve would be measuring its own earlier points.
        fn authored() -> (GridSession, Vec<u64>) {
            let mut session = GridSession::new(3);
            for i in 0..200i32 {
                session
                    .apply(GridCommand::Place {
                        kind: machine_kind::SOURCE,
                        cell_x: i * 2,
                        cell_y: 200,
                    })
                    .expect("place");
            }
            // 256 belts: `MAX_RUN_PACE_BELTS`, an order of magnitude past any run the
            // shipped traversal produces. Laid out four per row so the whole set fits
            // inside `GRID_MAX`.
            let mut handles = Vec::new();
            for i in 0..256i32 {
                let (_id, h) = belt(
                    &mut session,
                    vec![((i % 4) * 3, i / 4), ((i % 4) * 3 + 1, i / 4)],
                );
                handles.push(h);
            }
            (session, handles)
        }

        // The CURVE, not a single point: the cost is O(N x history), so one figure at
        // one run length cannot show which term dominates.
        for n in [1usize, 8, 32, 128, 256] {
            let (mut session, handles) = authored();
            let history = session.edit_log().len();
            let started = std::time::Instant::now();
            session
                .set_belt_run_pace(&handles[..n], RUN_PACE)
                .expect("the run is accepted");
            let elapsed = started.elapsed();
            println!(
                "set_belt_run_pace: {n:>3} belts over a {history}-record log took \
                 {elapsed:?} ({:?} per belt)",
                elapsed / u32::try_from(n).expect("the run length fits a u32"),
            );
        }
    }

    /// A fresh normal apply after an undo truncates the redo tail (Q1.1 linear history).
    #[test]
    fn driver_fresh_action_after_undo_kills_redo() {
        let mut session = GridSession::new(7);
        session
            .apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 0, cell_y: 0 })
            .expect("place");
        session.apply(GridCommand::Undo).expect("undo");
        assert!(session.can_redo(), "redoable right after the undo");
        session
            .apply(GridCommand::Place { kind: machine_kind::SOURCE, cell_x: 2, cell_y: 0 })
            .expect("a fresh normal action");
        assert!(!session.can_redo(), "the fresh action invalidated the redo stack");
    }

    /// **67-REVIEW CR-01, second half.** The compensating-`Dock` target-identity guard
    /// really bites: it accepts a live belt + live machine and refuses every other shape.
    ///
    /// This is a unit case and not an end-to-end leg on purpose. The guard's `false`
    /// branch is unreachable through `GridCommand` today — a severance harvested from a
    /// re-fold always names a node the fresh core classified `Node::Belt`, and `live()`
    /// maps it to the same record's live mint, which is a belt too. The branch exists for
    /// the LOAD path, where `GridSession::replay` is a `pub` primitive a forged or
    /// hand-edited log reaches. Driving the predicate directly is the only way to see it
    /// fail, and a guard that has never been seen to fail is not a guard.
    #[test]
    fn the_compensating_dock_guard_accepts_only_a_live_belt_and_a_live_machine() {
        let mut pred = Core::genesis(LogHeader { schema_version: SCHEMA_VERSION, seed: 1 });
        let belt = pred.state.add_belt(2);
        let machine = pred.state.add_endpoint();

        // A node id this core does NOT hold: minted in a SEPARATE core that ran further.
        let mut other = Core::genesis(LogHeader { schema_version: SCHEMA_VERSION, seed: 1 });
        for _ in 0..8 {
            other.state.add_endpoint();
        }
        let absent = other.state.add_belt(2);
        assert!(
            pred.state.node(absent).is_none(),
            "the premise: `absent` really is not a node of `pred`"
        );

        assert!(
            compensating_dock_is_foldable(&pred, belt, machine),
            "a live BELT docked to a live machine is exactly what the guard is for"
        );
        assert!(
            !compensating_dock_is_foldable(&pred, machine, machine),
            "a capture naming a MACHINE where the belt belongs is refused - fold_dock \
             checks existence only, so without the kind clause GridState::link would \
             write it into real state"
        );
        assert!(
            !compensating_dock_is_foldable(&pred, absent, machine),
            "a capture whose BELT this core does not hold is refused"
        );
        assert!(
            !compensating_dock_is_foldable(&pred, belt, absent),
            "a capture whose MACHINE this core does not hold is refused"
        );
    }

    /// **67-REVIEW CR-01 + WR-04, at the shared helper.** `attribute_severances` returns
    /// one entry per `Rotate` record - EMPTY VEC INCLUDED - and files each severance by
    /// `UnlinkedDock.node`, never by batch position.
    ///
    /// The empty-vec clause is the whole of CR-01 expressed as a unit contract: absence of
    /// a key must mean "no Rotate record here", never "a Rotate that severed nothing",
    /// because `reconstruct_projection`'s live-wins merge distinguishes exactly those two
    /// readings. Both harvests now go through this one function, so pinning it here pins
    /// the live path AND the load path at once (WR-04).
    #[test]
    fn attribute_severances_files_every_rotate_including_the_ones_that_severed_nothing() {
        let mut other_core =
            Core::genesis(LogHeader { schema_version: SCHEMA_VERSION, seed: 1 });
        let a = other_core.state.add_endpoint();
        let b = other_core.state.add_endpoint();
        let belt = other_core.state.add_belt(2);
        assert_ne!(a, b, "the two rotated nodes are distinct - the premise of the split");

        let rec = |sequence: u64, op: EditOp| EditRecord {
            schema_version: SCHEMA_VERSION,
            partition: Default::default(),
            sequence,
            tick: 0,
            action: 7,
            op,
        };
        let records = vec![
            rec(0, EditOp::Rotate { node: a, new_rot: 1, old_rot: 0 }),
            // A non-Rotate record between them: it must produce NO entry at all, and it
            // must not shift the attribution of the Rotate that follows it.
            rec(
                1,
                EditOp::Place {
                    kind: machine_kind::ROUTER,
                    cell_x: 0,
                    cell_y: 0,
                    w: 2,
                    h: 3,
                    ports: Vec::new(),
                    rot: 0,
                },
            ),
            rec(2, EditOp::Rotate { node: b, new_rot: 1, old_rot: 0 }),
        ];
        // Only `a` severed anything.
        let unlinked = vec![UnlinkedDock {
            belt,
            endpoint: fabrico_core::edit::BeltEnd::Tail,
            node: a,
            port: 0,
        }];

        let out = attribute_severances(&records, &unlinked, None);

        assert_eq!(
            out.len(),
            2,
            "one entry per ROTATE record and nothing for the Place: {out:?}"
        );
        assert_eq!(out[0].0, (7, 0), "keyed by (action, sequence), in record order");
        assert_eq!(out[0].1, unlinked, "node `a`'s severance is filed under `a`'s record");
        assert_eq!(out[1].0, (7, 2), "the Place did not shift the second Rotate's key");
        assert!(
            out[1].1.is_empty(),
            "node `b` severed NOTHING and is STILL filed, with an empty vec - absence of \
             a key has to mean \"no Rotate record here\", never \"severed nothing\" \
             (67-REVIEW CR-01)"
        );

        // And a batch with no Rotate at all files nothing. Its severed set is EMPTY: a batch
        // with no severing record severs nothing, and since phase 89 the attribution checks
        // that every severance it is handed is filed exactly once.
        assert!(
            attribute_severances(&records[1..2], &[], None).is_empty(),
            "a batch carrying no Rotate record files no key"
        );
    }
}
