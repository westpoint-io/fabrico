//! Behavioral item-flow equivalence harness (SC#2, RESEARCH Pitfall 2 / A2).
//!
//! Phase 9 moves the spatial (cell) model out of the host sidecar and INTO the
//! deterministic core (`GridState.cells`). The load-bearing correctness claim is
//! that the spatial dimension is **inert to the dynamics**: placing a machine at a
//! 1×1 cell must produce the EXACT same item flow — routing decisions, fault
//! emissions, arrival ticks — as the v1.0-style cell-less "point machine". A belt
//! of length 1 must behave identically to a depth-1 delay line.
//!
//! # This is BEHAVIORAL equivalence, NEVER snapshot-byte comparison
//! Across the v3→v4 snapshot boundary the bytes DIFFER by construction (v4 appends
//! the `cells` map), so comparing snapshot bytes would be a false negative
//! (RESEARCH Pitfall 2 / A2). Equivalence is asserted on the OBSERVABLE
//! item-flow outcomes only — the ordered delivered payloads and their arrival
//! ticks — captured by [`drive`] driving the SAME inject log through both grids.
//!
//! # GREEN (09-02 landed `GridState.cells`)
//! The point-machine baseline ([`point_machine_flow`] / [`length_1_belt_flow`]) runs
//! against the cell-less public API; the spatial side ([`spatial_1x1_flow`] /
//! [`spatial_length_1_belt_flow`]) places the SAME topology at explicit grid cells
//! via `GridState::set_cell` (the public accessor the `fold_place` cell write also
//! drives). Both sides assert IDENTICAL observable item flow — proving the cell
//! dimension is inert to the dynamics (SC#2 / A2).
//!
//! Run target: `cargo test -p fabrico-core --test spatial_equivalence`.

use fabrico_core::core::Core;
use fabrico_core::event::{Event, EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::state::{Footprint, cells_of_footprint};

/// A genesis header carrying `seed`.
fn header(seed: u64) -> LogHeader {
    LogHeader {
        schema_version: SCHEMA_VERSION,
        seed,
    }
}

/// One `ManualInject` event stamped at `tick`.
fn inject(target: NodeId, seq: u64, tick: u64, item: Item) -> Event {
    Event {
        schema_version: SCHEMA_VERSION,
        partition: 0,
        sequence: seq,
        tick,
        payload: EventPayload::ManualInject {
            target,
            port: 0,
            item,
        },
    }
}

/// The observable item-flow outcome of driving a fixed inject log through a grid:
/// the ordered payloads that reached the terminal collector and the tick each one
/// arrived. This — NOT the snapshot bytes — is the equivalence oracle (Pitfall 2).
#[derive(Debug, Default, PartialEq, Eq)]
struct ItemFlow {
    /// Items delivered to the collector, in arrival order.
    delivered: Vec<Item>,
    /// The `core.tick` boundary at which each corresponding delivery first landed.
    arrival_ticks: Vec<u64>,
}

/// The fixed three-item inject log every flow is driven with (distinct payloads so
/// ordering is observable).
const PAYLOADS: [u8; 3] = [0xA1, 0xB2, 0xC3];

/// Drive the canonical inject log through a grid built by `build` (which wires the
/// topology and returns its `(source, collector)` endpoints) and capture the
/// observable [`ItemFlow`]. The collector is a `Source` (it ignores its input), so
/// delivered items accumulate FIFO in its inbox; we snapshot the inbox each tick to
/// record arrival timing.
fn drive(build: impl FnOnce(&mut Core) -> (NodeId, NodeId)) -> ItemFlow {
    let mut core = Core::genesis(header(0xE0F_F1ED));
    let (source, collector) = build(&mut core);

    let mut flow = ItemFlow::default();
    let mut seen = 0usize;
    // Inject one item per tick for the first three ticks; idle thereafter so any
    // belt-delayed item has time to arrive within the horizon.
    let horizon = 16u64;
    for t in 0..horizon {
        let inbound: Vec<Event> = if (t as usize) < PAYLOADS.len() {
            vec![inject(source, t + 1, t, Item(vec![PAYLOADS[t as usize]]))]
        } else {
            Vec::new()
        };
        core.advance(&inbound);

        // Snapshot the collector inbox and record any newly-arrived items.
        if let Some(inbox) = core.state.inbox_of(collector) {
            let mut clone = inbox.clone();
            let mut all = Vec::new();
            while let Some((_seq, item)) = clone.take(0) {
                all.push(item);
            }
            while seen < all.len() {
                flow.delivered.push(all[seen].clone());
                flow.arrival_ticks.push(core.tick);
                seen += 1;
            }
        }
    }
    flow
}

/// Baseline: the v1.0-style cell-less "point machine" — a `source -> belt(0) ->
/// collector` instant-wire chain built purely through the current public API (no
/// cells). Returns its `(source, collector)`.
fn point_machine_flow() -> ItemFlow {
    drive(|core| {
        let s = core.state.add_source();
        let b = core.state.add_belt(0); // instant wire: the degenerate point machine
        let c = core.state.add_source(); // collector (ignores its input)
        core.state.link((s, 0), (b, 0));
        core.state.link((b, 0), (c, 0));
        (s, c)
    })
}

/// Baseline: a depth-1 delay line — `source -> belt(1) -> collector`. The v4 side
/// (09-02) drives the SAME topology placed at a length-1 cell span; the item flow
/// must match this depth-1 baseline.
fn length_1_belt_flow() -> ItemFlow {
    drive(|core| {
        let s = core.state.add_source();
        let b = core.state.add_belt(1); // depth-1 delay line
        let c = core.state.add_source();
        core.state.link((s, 0), (b, 0));
        core.state.link((b, 0), (c, 0));
        (s, c)
    })
}

/// The 1×1 cell-placement side: the SAME `source -> belt(0) -> collector` point
/// machine, but every node placed at an explicit 1×1 grid cell via the v4
/// `GridState::set_cell` (the spatial model now in the deterministic core). The cell
/// metadata is inert to the dynamics, so the observable item flow must match the
/// cell-less [`point_machine_flow`].
fn spatial_1x1_flow() -> ItemFlow {
    drive(|core| {
        let s = core.state.add_source();
        let b = core.state.add_belt(0); // instant wire: the degenerate point machine
        let c = core.state.add_source(); // collector (ignores its input)
        // Place each machine at a single (x, y) cell — the 1×1 footprint.
        core.state.set_cell(s, (0, 0));
        core.state.set_cell(b, (1, 0));
        core.state.set_cell(c, (2, 0));
        core.state.link((s, 0), (b, 0));
        core.state.link((b, 0), (c, 0));
        (s, c)
    })
}

/// The length-1-cell-span side: a depth-1 belt placed across a length-1 cell span
/// via `GridState::set_cell`. Its item flow must match the cell-less depth-1
/// [`length_1_belt_flow`].
fn spatial_length_1_belt_flow() -> ItemFlow {
    drive(|core| {
        let s = core.state.add_source();
        let b = core.state.add_belt(1); // depth-1 delay line
        let c = core.state.add_source();
        core.state.set_cell(s, (0, 0));
        core.state.set_cell(b, (1, 0)); // length-1 belt span (single cell)
        core.state.set_cell(c, (2, 0));
        core.state.link((s, 0), (b, 0));
        core.state.link((b, 0), (c, 0));
        (s, c)
    })
}

/// The v5 (10-02) footprint side: the SAME `source -> belt(0) -> collector` point
/// machine, each node placed at its 1×1 cell AND carrying an EXPLICIT 1×1 rot0
/// [`Footprint`] written via the new `GridState::set_footprint` path (the
/// `footprints` map that joined the wire at `SNAPSHOT_SCHEMA_VERSION` 5). A 1×1
/// footprint is the faithful default — even when made explicit it must be inert to
/// the dynamics — so the observable item flow must still match the cell-less
/// [`point_machine_flow`] (carrying the Phase-9 SPAT-02 1×1==v1.0 gate onto v5).
fn spatial_1x1_footprint_flow() -> ItemFlow {
    drive(|core| {
        let s = core.state.add_source();
        let b = core.state.add_belt(0); // instant wire: the degenerate point machine
        let c = core.state.add_source(); // collector (ignores its input)
        let one_by_one = Footprint { w: 1, h: 1, rot: 0 };
        for (id, cell) in [(s, (0, 0)), (b, (1, 0)), (c, (2, 0))] {
            core.state.set_cell(id, cell);
            core.state.set_footprint(id, one_by_one); // explicit 1×1 via the v5 map
        }
        core.state.link((s, 0), (b, 0));
        core.state.link((b, 0), (c, 0));
        (s, c)
    })
}

/// The 10-03 generalized-claim side: the SAME `source -> belt(0) -> collector` point
/// machine, but every node placed via `GridState::claim_footprint` as a 1×1 (the
/// multi-cell storage primitive that replaced `set_cell` on the fold path). A 1×1
/// claim is byte-identical to `set_cell`, so the observable item flow must still match
/// the cell-less [`point_machine_flow`] — proving the generalized claim path stays
/// faithful (SPAT-02 carried onto the FOOT-01 mechanism).
fn claim_1x1_flow() -> ItemFlow {
    drive(|core| {
        let s = core.state.add_source();
        let b = core.state.add_belt(0); // instant wire: the degenerate point machine
        let c = core.state.add_source(); // collector (ignores its input)
        core.state.claim_footprint(s, (0, 0), 1, 1, 0);
        core.state.claim_footprint(b, (1, 0), 1, 1, 0);
        core.state.claim_footprint(c, (2, 0), 1, 1, 0);
        core.state.link((s, 0), (b, 0));
        core.state.link((b, 0), (c, 0));
        (s, c)
    })
}

/// The 10-03 multi-cell side: the SAME point machine, but the belt is claimed as a
/// 2×3 (>1×1) footprint at a distinct anchor. The footprint dimension is INERT to the
/// dynamics — the node still steps once as one logical machine — so the item flow must
/// match the cell-less [`point_machine_flow`] baseline. Body-occupancy of the 2×3 is
/// asserted separately in `multicell_footprint_body_reads_fully_occupied`.
fn multicell_belt_flow() -> ItemFlow {
    drive(|core| {
        let s = core.state.add_source();
        let b = core.state.add_belt(0); // instant wire — the dynamics-bearing node
        let c = core.state.add_source(); // collector (ignores its input)
        core.state.claim_footprint(s, (0, 0), 1, 1, 0);
        core.state.claim_footprint(b, (2, 2), 2, 3, 0); // 2×3 multi-cell body
        core.state.claim_footprint(c, (8, 0), 1, 1, 0);
        core.state.link((s, 0), (b, 0));
        core.state.link((b, 0), (c, 0));
        (s, c)
    })
}

#[test]
fn claim_footprint_1x1_equals_point_machine() {
    // 10-03 / FOOT-01: a 1×1 placed via the generalized `claim_footprint` path is
    // item-flow-identical to the cell-less point machine — the claim path is faithful.
    assert_eq!(
        point_machine_flow(),
        claim_1x1_flow(),
        "a 1x1 placed via claim_footprint must be item-flow-equivalent to the point machine"
    );
}

#[test]
fn multicell_footprint_is_item_flow_inert() {
    // 10-03 / FOOT-01: a >1×1 (2×3) footprint produces the IDENTICAL item flow as the
    // 1×1 point machine — multi-cell occupancy is spatial-only, the node steps once.
    assert_eq!(
        point_machine_flow(),
        multicell_belt_flow(),
        "a >1x1 footprint must be item-flow-equivalent to the 1x1 point machine (dimension inert)"
    );
}

#[test]
fn multicell_footprint_body_reads_fully_occupied() {
    // 10-03 / FOOT-01: every body cell of a 2×3 claimed footprint reads occupied by the
    // single logical node, and a cell just outside the body is free — the spatial body
    // is fully claimed while the dynamics treat it as one node (see the inert flow test).
    let mut core = Core::genesis(header(0xF007));
    let b = core.state.add_belt(0);
    core.state.claim_footprint(b, (2, 2), 2, 3, 0);
    for cell in cells_of_footprint((2, 2), 2, 3, 0) {
        assert_eq!(
            core.state.occupied(cell),
            Some(b),
            "every body cell {cell:?} of a multi-cell footprint reads occupied"
        );
    }
    assert_eq!(
        core.state.occupied((4, 2)),
        None,
        "a cell just outside the footprint body is free"
    );
}

#[test]
fn explicit_1x1_footprint_equals_point_machine() {
    // 10-02 / FOOT-01: an EXPLICIT 1×1 rot0 footprint written via the v5 `footprints`
    // map is item-flow-identical to the cell-less point machine — the footprint
    // dimension is inert to the dynamics exactly as the cell dimension is. This is
    // the v5 carry-forward of the Phase-9 1×1==v1.0 equivalence gate.
    assert_eq!(
        point_machine_flow(),
        spatial_1x1_footprint_flow(),
        "an explicit 1x1 footprint must be item-flow-equivalent to the point machine"
    );
}

#[test]
fn degenerate_1x1_equals_point_machine() {
    // The cell dimension is inert to dynamics: a machine placed at a 1×1 cell
    // produces the identical item flow as the v1.0-style cell-less point machine.
    assert_eq!(
        point_machine_flow(),
        spatial_1x1_flow(),
        "a 1x1-cell machine must be item-flow-equivalent to the point machine"
    );
}

#[test]
fn length_1_belt_equals_depth_1() {
    // A belt occupying a length-1 cell span behaves exactly as a depth-1 delay line.
    assert_eq!(
        length_1_belt_flow(),
        spatial_length_1_belt_flow(),
        "a length-1 belt must be item-flow-equivalent to a depth-1 delay line"
    );
}
