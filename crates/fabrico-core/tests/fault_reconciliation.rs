//! DET-05 — the hand-built `Role::Fault` ↔ `FAULT_PORT` reconciliation fixture.
//!
//! Phase 17 makes the FACTORY's ERROR output a REAL spatial `Role::Fault` port (array
//! index 2, S-center) that nonetheless ROUTES AS the reserved sentinel
//! `FAULT_PORT = u16::MAX` (Option A). This test PINS that reconciliation contract as a
//! single reviewed artifact, BEFORE the core organically emits `Role::Fault` from a
//! factory — the four properties the render/route/snapshot layers all depend on:
//!
//!   1. `port_catalog(FACTORY).1[2].role == Role::Fault` at the S-center offset (1,2)/S.
//!   2. A belt docked to the fault nub produces a `links` entry whose KEY equals the
//!      factory's fault-emit key `(factory, FAULT_PORT)` — dock key == emit key, so a
//!      faulted item actually flows onto the docked belt (Pitfall 5).
//!   3. Under `(port_index asc)` the Fault port sorts LAST (array index 2); and on the
//!      routing side `FAULT_PORT == u16::MAX` sorts LAST among any ascending port ids.
//!   4. The docked-fault state round-trips BYTE-IDENTICALLY through snapshot/restore at
//!      SNAPSHOT schema 7.
//!
//! The dock is driven through the REAL command layer (`GridSession`, 17-04's Option-A
//! reconciliation: a `Role::Fault` target is spatially validated like `Out` and its link
//! key is resolved to `FAULT_PORT`), so this fixture exercises the actual reconciliation
//! path, not a hand-forged link.

use fabrico_command::GridSession;
use fabrico_command::command::port_catalog;
use fabrico_core::fault::FAULT_PORT;
use fabrico_core::snapshot;
use fabrico_core::state::{Node, Role, Router, Side, Sink, SinkTemplate, base_footprint};
use fabrico_protocol::{BeltEnd, GridCommand, machine_kind};

/// Property 1 + 3 (catalog side): the FACTORY catalog pins Fault at array index 2, the
/// S-center offset, and it sorts LAST under `(port_index asc)`.
#[test]
fn fault_reconciliation_catalog_pins_fault_at_index_2_s_center_sorts_last() {
    let (footprint, ports) = port_catalog(machine_kind::FACTORY);
    assert_eq!((footprint.w, footprint.h), (3, 3), "FACTORY is 3x3");
    assert_eq!(ports.len(), 3, "FACTORY has In, Out, Fault");

    // Index 2 is the Fault port at the S-center perimeter offset.
    let fault = ports[2];
    assert_eq!(fault.role, Role::Fault, "ports[2] is the Role::Fault nub");
    assert_eq!(fault.local_offset, (1, 2), "Fault is S-center (local (1,2))");
    assert_eq!(fault.side, Side::S, "Fault faces South");

    // Sorts LAST under (port_index asc): no non-Fault port has a higher array index.
    let fault_idx = ports
        .iter()
        .position(|p| p.role == Role::Fault)
        .expect("a Fault port exists");
    assert_eq!(fault_idx, ports.len() - 1, "Fault sorts LAST by array index");

    // Routing side: FAULT_PORT (u16::MAX) sorts LAST above any small ascending port id.
    // THIS `assert_eq!` IS THE WHOLE ROUTING-SIDE ASSERTION, and the line that used to
    // follow it has been DELETED rather than repaired.
    //
    // It read `assert!(FAULT_PORT > 1, "FAULT_PORT sorts after In(0)/Out(1)")`, which
    // clippy::assertions_on_constants flags because it compares two constants and is
    // const-folded away. The first repair derived the bar from the runtime catalog
    // (`fault_idx - 1`) to dodge the lint. An adversarial review of that repair found it
    // was just as vacuous while its comment claimed it now "bites on a catalog that grows
    // a port" - it does not, and the overclaim is the failure mode this milestone has paid
    // for six times, so it is recorded here rather than left in the tree.
    //
    // THE PROPERTY IS UNPROVABLE BY CONSTRUCTION, which is the honest reason to delete it
    // instead of rewriting it a third time. Port routing keys are `u16` and the line above
    // pins `FAULT_PORT` to `u16::MAX`, so no port index can exceed it and no comparison
    // can ever fail - not for a catalog that grows, not for one that shrinks. `> 1` was
    // never measuring the fault key's ordering; the `assert_eq!` above is what measures
    // it, and the `fault_idx == ports.len() - 1` assertion above measures the ARRAY-index
    // half of "sorts last" on the real catalog. Between them the property is fully
    // covered. A third assertion that cannot fail would add only the appearance of rigour.
    assert_eq!(FAULT_PORT, u16::MAX, "the fault routing key is the max port id");
}

/// Property 1 + 3 (catalog side) for the SINK, in the FACTORY pin's shape: PILE-10
/// gives the Sink a spatial `Role::Fault` nub at array index 1, `S@(0,0)`, sorting LAST
/// under `(port_index asc)` - and the declared 1x1 box does NOT grow, because both ports
/// share the one cell (the ENDPOINT arm's precedent).
///
/// # Why this pin lives HERE and not under `-p fabrico-command` (ruling R-20a)
///
/// PILE-10's written acceptance names "a `cargo test -p fabrico-command` on the widened
/// SINK and ROUTER arms". **This is a deviation and it is labelled one rather than passed
/// off as compliance.** The FACTORY pin above is the only existing per-kind catalog pin
/// in the repository, it pins the only existing `Role::Fault` port, and its shape (kind,
/// footprint, count, offset, side, sorts-last) is exactly what the two new kinds need.
/// Splitting the three Fault pins across two crates so that two of them match a
/// requirement's crate name would put the Factory's pin and the Sink's pin in different
/// files asserting the same property.
///
/// The cost is paid deliberately and is named so a reviewer can weigh it: this file is a
/// COVERED source path under the phase-70 declared-moves gate and `fabrico-command`'s
/// test tree is not, so the choice adds one `[source]` declaration line the alternative
/// would not. The invariants PILE-10 names by crate are still run under
/// `-p fabrico-command`: `port_catalog_every_kind_lists_in_ports_first` and the
/// base-parity test both live there and both pass. Moving these pins would be a file move
/// with no assertion change.
#[test]
fn fault_reconciliation_catalog_pins_sink_fault_at_index_1_s_side_sorts_last() {
    let (footprint, ports) = port_catalog(machine_kind::SINK);
    assert_eq!((footprint.w, footprint.h), (1, 1), "SINK is 1x1");
    assert_eq!(ports.len(), 2, "SINK has In then Fault");

    let fault = ports[1];
    assert_eq!(fault.role, Role::Fault, "ports[1] is the Role::Fault nub");
    assert_eq!(fault.local_offset, (0, 0), "Fault shares the ONE cell with the In");
    assert_eq!(fault.side, Side::S, "Fault faces South");
    assert_eq!(ports[0].role, Role::In, "the In still leads, at index 0");
    assert_eq!(ports[0].side, Side::W, "and still faces West");

    let fault_idx = ports
        .iter()
        .position(|p| p.role == Role::Fault)
        .expect("a Fault port exists");
    assert_eq!(fault_idx, ports.len() - 1, "Fault sorts LAST by array index");

    // BASE PARITY. The catalog floor and the CORE floor must agree, or a placement
    // writes a footprint the core would not floor to. `base_footprint` is the core's
    // side of that contract and it is read here rather than restated as a literal.
    assert_eq!(
        (footprint.w, footprint.h),
        {
            let base = base_footprint(&Node::Sink(Sink::new(SinkTemplate::Debug, 1)));
            (base.w, base.h)
        },
        "the SINK catalog box still equals base_footprint(Node::Sink): adding a second \
         port to the ONE cell must not grow it"
    );
}

/// Property 1 + 3 (catalog side) for the ROUTER: PILE-10 appends a spatial `Role::Fault`
/// nub at `S@(0,2)`, the LAST array index, and the declared 2x3 box does NOT grow.
///
/// The offset is 71-UI-SPEC's and is measured rather than chosen: the bottom-LEFT cell
/// leaves 38.480 px of bare ink gap to the nearest existing nub where the bottom-RIGHT
/// cell would leave 10.585 px against an Out at `E@(1,2)`. See R-20a above for
/// why this pin lives in this file.
#[test]
fn fault_reconciliation_catalog_pins_router_fault_last_at_s_0_2_sorts_last() {
    let (footprint, ports) = port_catalog(machine_kind::ROUTER);
    assert_eq!((footprint.w, footprint.h), (2, 3), "ROUTER is 2x3");

    let fault_idx = ports
        .iter()
        .position(|p| p.role == Role::Fault)
        .expect("a Fault port exists");
    assert_eq!(fault_idx, ports.len() - 1, "Fault sorts LAST by array index");
    assert_eq!(
        ports.iter().filter(|p| p.role == Role::Fault).count(),
        1,
        "exactly ONE Fault nub"
    );

    let fault = ports[fault_idx];
    assert_eq!(fault.role, Role::Fault, "the last port is the Role::Fault nub");
    assert_eq!(fault.local_offset, (0, 2), "Fault is the bottom-LEFT cell");
    assert_eq!(fault.side, Side::S, "Fault faces South");

    // The INDICES before the Fault are unmoved. A `PortId` is an index into this Vec, so
    // this is the assertion that the append re-pointed no existing dock. The CELLS moved
    // in 74.1-14 (layout ruling 2026-10-04, "Edits keep middle layout"): the In from
    // (0,0) and the first Out from (1,2) to the middle row, the port-edit reseat rule's
    // slots, with every board that docked the old cells redrawn in the same plan.
    assert_eq!(ports[0].role, Role::In, "index 0 is still the In");
    assert_eq!(ports[0].local_offset, (0, 1), "on the middle row since 74.1-14");
    assert_eq!(ports[1].role, Role::Out, "index 1 is still the first Out");
    assert_eq!(ports[1].local_offset, (1, 1), "on the middle row since 74.1-14");

    assert_eq!(
        (footprint.w, footprint.h),
        {
            let base = base_footprint(&Node::Router(Router::new(Vec::new(), None)));
            (base.w, base.h)
        },
        "the ROUTER catalog box still equals base_footprint(Node::Router): the appended \
         Fault sits inside the frozen 2x3 and must not grow it"
    );
}

/// Property 2 + 4: a belt docked to the FACTORY fault nub keys on `FAULT_PORT` (the
/// same key the factory faults on), and the docked-fault topology round-trips
/// byte-identically at snapshot schema 7.
#[test]
fn fault_reconciliation_dock_keys_on_fault_port_and_round_trips_at_schema_7() {
    const SEED: u64 = 0x00FA_017E;
    let mut session = GridSession::new(SEED);

    // Place a FACTORY at (0,0): its 3x3 body is (0,0)..=(2,2); the Fault nub world-cell
    // is (1,2) facing S, so its facing cell (one step S) is (1,3).
    session
        .apply(GridCommand::Place { kind: machine_kind::FACTORY, cell_x: 0, cell_y: 0 })
        .expect("place the factory");
    let factory_id = *session
        .core()
        .last_tick
        .placed
        .last()
        .expect("factory minted");
    let factory_h = session
        .view()
        .handle_of(factory_id)
        .expect("factory got a dense handle");

    // Draw a 1-tile belt on the fault nub's facing cell (1,3): head==tail==(1,3), one
    // step S of the Fault port — a facing-adjacent Tail OFFLOAD dock target.
    session
        .apply(GridCommand::DrawBelt { cells: vec![(1, 3)] })
        .expect("draw the fault belt");
    let belt_id = *session.core().last_tick.placed.last().expect("belt minted");
    let belt_h = session
        .view()
        .handle_of(belt_id)
        .expect("belt got a dense handle");

    // Dock the belt TAIL to the fault port by its SPATIAL INDEX (2). 17-04 Option A
    // spatially validates it like an Out dock and RESOLVES the link key to FAULT_PORT.
    session
        .apply(GridCommand::Dock {
            belt: belt_h,
            endpoint: BeltEnd::Tail,
            node: factory_h,
            port: 2,
        })
        .expect("offload-dock the belt tail to the factory Fault port");

    // Property 2: the dock link is keyed on (factory, FAULT_PORT) — the SAME key the
    // factory emits its faults on — so a faulted item reaches the docked belt.
    assert_eq!(
        session.core().state.link_target((factory_id, FAULT_PORT)),
        Some((belt_id, 0)),
        "the fault dock keys on FAULT_PORT == the fault-emit key (Option A)"
    );
    // And it is NOT keyed on the bare spatial index 2 (that key must be absent).
    assert_eq!(
        session.core().state.link_target((factory_id, 2)),
        None,
        "the dock link is resolved to FAULT_PORT, not left on the spatial index"
    );

    // Property 4: the docked-fault topology round-trips byte-identically at schema 7.
    let frozen = snapshot::snapshot(session.core());
    let restored = snapshot::restore(&frozen).expect("docked-fault snapshot restores at v7");
    let refrozen = snapshot::snapshot(&restored);
    assert_eq!(
        frozen, refrozen,
        "the docked-fault state round-trips byte-identically through snapshot/restore (schema 7)"
    );
    // The reconciled link survives the round-trip.
    assert_eq!(
        restored.state.link_target((factory_id, FAULT_PORT)),
        Some((belt_id, 0)),
        "the FAULT_PORT dock link survives snapshot/restore"
    );
}
