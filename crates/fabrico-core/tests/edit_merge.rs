//! 08-03 — dedicated OBSERVABLE-behavior proofs for the two-log EDITS-FIRST merge
//! (ELOG-03 / Q3), complementing the frozen-hash assertions in
//! `cert_cross_platform.rs` for fixtures 0007/0008.
//!
//! These build the same topologies the 0007/0008 generators do but drive them via
//! the public `Core::run_log_two_logs` and assert the *behavior* directly (with the
//! node ids known at build time), so a regression is legible as "the grafted branch
//! never delivered" / "the deleted belt's item resurfaced" rather than only a
//! changed hash.

mod common;

use common::{collector_count, collector_items, fire, header};
use fabrico_core::core::Core;
use fabrico_core::edit::{BeltEnd, EDIT_SCHEMA_VERSION, EditOp, EditRecord};
use fabrico_core::ids::Item;
use fabrico_core::state::{BeltTile, TileKind};

/// `machine_kind` u8 convention (fabrico-core is protocol-free; mirror it locally).
const KIND_SOURCE: u8 = 0;
const KIND_BELT: u8 = 1;

fn edit_record(seq: u64, tick: u64, op: EditOp) -> EditRecord {
    EditRecord {
        schema_version: EDIT_SCHEMA_VERSION,
        partition: 0,
        sequence: seq,
        tick,
        action: 0,
        op,
    }
}

#[test]
fn interleaved_edit_during_flow() {
    // s -> b(3) -> c, with item1 in flight. At tick 2 an edit grafts a new source s2,
    // draws a belt and docks it s2 -> belt -> c (DrawBelt+Dock, the post-Wire model), AND
    // the event-log fires item2 into s2 at tick 2. EDITS-FIRST means s2 + its belt exist
    // before that tick's event fold, so item2 flows to c. Under an events-first order the
    // fire would hit a missing target and drop.
    let mut core = Core::genesis(header(0x0007_ED17));
    let s = core.state.add_source();
    let b = core.state.add_belt(3);
    let c = core.state.add_source();
    core.state.link((s, 0), (b, 0));
    core.state.link((b, 0), (c, 0));
    let _ = b;

    let place_s2 = edit_record(
        1,
        2,
        EditOp::Place {
            kind: KIND_SOURCE,
            cell_x: 0,
            cell_y: 0,
            w: 1,
            h: 1,
            ports: vec![],
            rot: 0,
        },
    );
    let draw_belt = edit_record(
        2,
        2,
        EditOp::DrawBelt {
            tiles: vec![BeltTile::new((2, 0), TileKind::default())],
        },
    );

    // Discover s2 + the drawn belt (the tick-2 mints) on a clone — nothing mints before
    // tick 2, so fold order gives placed = [s2, belt].
    let (s2, belt) = {
        let mut probe = core.clone();
        probe.advance_edits(&[place_s2.clone(), draw_belt.clone()], &[]);
        (probe.last_tick.placed[0], probe.last_tick.placed[1])
    };

    let edits = vec![
        place_s2,
        draw_belt,
        // Tail dock: s2 Out feeds the belt entry (link (s2,0)->(belt,0)).
        edit_record(3, 2, EditOp::Dock { belt, endpoint: BeltEnd::Tail, node: s2, port: 0 }),
        // Head dock: the belt delivers into c (link (belt,0)->(c,0)).
        edit_record(4, 2, EditOp::Dock { belt, endpoint: BeltEnd::Head, node: c, port: 0 }),
    ];
    let log = vec![
        fire(s, 1, 0, Item(vec![0x01])),
        fire(s2, 2, 2, Item(vec![0x02])),
    ];

    core.run_log_two_logs(&edits, &log).expect("replay within MAX_REPLAY_SPAN");
    // Drive enough settle ticks for BOTH slot belts to traverse: the original
    // belt(3 tiles) item1 needs SLOTS_PER_TILE*3-1 ADVANCES tail->head; item2 rides a
    // 1-tile drawn belt. Collect until both have arrived (bounded).
    //
    // A DERIVED BUDGET (SLOT-04, `62-CONTEXT.md` D-01). Advances are not ticks: a belt
    // advances one slot every `ticks_per_slot` ticks, so a flat 20 under-ran from an
    // interval of 3 upward and the test then failed on "the grafted branch delivered
    // item2", which reads as an EDITS-FIRST ordering failure rather than as a budget.
    // That is the whole hazard: this test's subject is fold ORDER, so a timing under-run
    // impersonates the defect it exists to catch. Found by plan 62-03's mutation drill
    // (FINDING 3-C), not by the grep that found the prose surface.
    let interval = u64::from(fabrico_core::belt_slots::DEFAULT_TICKS_PER_SLOT.get());
    let mut items = collector_items(&core, c);
    for _ in 0..(20 * interval) {
        if items.contains(&Item(vec![0x01])) && items.contains(&Item(vec![0x02])) {
            break;
        }
        core.advance(&[]);
        items = collector_items(&core, c);
    }
    assert!(
        items.contains(&Item(vec![0x02])),
        "the grafted branch delivered item2 to the collector (EDITS-FIRST): {items:?}"
    );
    assert!(
        items.contains(&Item(vec![0x01])),
        "the original in-flight item still arrived: {items:?}"
    );
}

#[test]
fn mid_flow_delete_drops_items() {
    // s -> b(3) -> c, item fired at tick 0. At tick 1 (mid-belt) the edit-log deletes
    // b. The in-flight item drops via the existing missing-link no-op (Q3): no panic on
    // later ticks, and the item never resurfaces at the collector.
    let mut core = Core::genesis(header(0x0008_DE17));
    let s = core.state.add_source();
    let b = core.state.add_belt(3);
    let c = core.state.add_source();
    core.state.link((s, 0), (b, 0));
    core.state.link((b, 0), (c, 0));

    let log = vec![fire(s, 1, 0, Item(vec![0x77]))];
    let edits = vec![edit_record(
        1,
        1,
        EditOp::Delete {
            node: b,
            kind: KIND_BELT,
            cell_x: 0,
            cell_y: 0,
            captured: Default::default(),
        },
    )];

    core.run_log_two_logs(&edits, &log).expect("replay within MAX_REPLAY_SPAN");
    // Advance well past the belt's original arrival (tick 3): must not panic on a dead
    // scheduled id, and nothing may resurface.
    for _ in 0..4 {
        core.advance(&[]);
    }

    assert!(core.state.node(b).is_none(), "the belt stays deleted (no resurrection)");
    assert_eq!(
        collector_count(&core, c),
        0,
        "the in-flight item dropped with the deleted belt (Q3 missing-link no-op)"
    );
}
